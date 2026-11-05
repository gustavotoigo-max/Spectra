# Spectra

Transmissão de tela para o seu grupo, no estilo do Discord: um app para Windows em C#, um servidor SFU gratuito e uma página de download.

```
Transmissor (Spectra.exe) ──1 fluxo, 3 camadas──► Servidor SFU (LiveKit) ──┬──► Espectador 1 (escolheu 1080p60)
                                                                           ├──► Espectador 2 (escolheu 720p30)
                                                                           └──► Espectador 3 (escolheu 360p15)
```

- **Quem transmite envia uma vez só.** O servidor replica para cada espectador, sem recodificar nada.
- **Simulcast:** o transmissor manda 3 versões (por exemplo 1080p60, 720p30 e 360p15) e cada espectador escolhe a que quer receber. Se a internet de alguém piorar, o servidor baixa a qualidade só para essa pessoa.
- **Áudio do computador** em estéreo, 128 kbps, sem cancelamento de eco nem redução de ruído.
- **Ninguém recebe vídeo à toa:** você só baixa a transmissão de quem está assistindo, como no Discord.

## Estrutura

| Pasta | O que é |
| --- | --- |
| `app/Spectra` | App para Windows: WPF + WebView2 (.NET 8). A interface (HTML/CSS/JS, com o SDK do LiveKit) vai embutida no `.exe`. |
| `server/` | Servidor: LiveKit (SFU), serviço de tokens em C# e Caddy (HTTPS automático), tudo em Docker. |
| `site/` | Página de download (GitHub Pages). |
| `.github/workflows` | Build do `.exe` no Windows, release por tag e publicação da página. |

## 1. Subir o servidor (grátis, na Oracle Cloud)

O nível *Always Free* da Oracle tem VMs ARM com folga de CPU e uma cota de tráfego de saída bem alta, o suficiente para transmitir para um grupo de amigos sem custo. Confira os limites atuais na página da Oracle ao criar a conta.

1. Crie uma conta em [cloud.oracle.com](https://cloud.oracle.com) e uma instância **Ampere A1** (1 OCPU e 6 GB já sobram) com **Ubuntu 22.04 ou 24.04**.
2. Na **Security List** da rede da VM (VCN → Subnet → Security List → *Add Ingress Rules*), libere de `0.0.0.0/0`:

   | Protocolo | Portas | Para quê |
   | --- | --- | --- |
   | TCP | 80, 443 | HTTPS (Caddy) e emissão do certificado |
   | TCP | 7881 | mídia via TCP, quando o UDP está bloqueado |
   | UDP | 3478 | TURN, para redes restritivas |
   | UDP | 50000–60000 | mídia WebRTC |

3. Entre na VM por SSH e rode:

   ```bash
   git clone https://github.com/gustavotoigo-max/Spectra.git
   cd Spectra/server
   sudo ./install.sh
   ```

   O script instala o Docker, libera o firewall da própria VM, gera as chaves, configura o LiveKit e sobe tudo. No fim ele mostra:

   ```
   Servidor:         https://129-146-10-20.sslip.io
   Chave de acesso:  3f9a1c07e2
   ```

   Sem domínio próprio, o endereço usa o [sslip.io](https://sslip.io) (o IP vira um nome) e o certificado HTTPS sai de graça pelo Let's Encrypt. Com domínio próprio: `sudo ./install.sh meu.dominio.com`.

Para atualizar depois: `git pull && sudo ./install.sh` (as chaves são mantidas).

### Limite de tráfego (5 TB por mês)

A Oracle Always Free inclui 10 TB de tráfego de saída por mês. Para nunca passar disso, o serviço de tokens mede o que sai da VM a cada minuto e, ao chegar em **5 TB** no mês:

- o app mostra o aviso e não deixa criar nem entrar em salas;
- as salas abertas são encerradas, com o aviso para quem estava nelas;
- a página de download mostra o aviso no topo.

A partir de 80% do limite, o app e a página já mostram um aviso amarelo. O contador zera no dia 1º de cada mês (UTC) e fica salvo no volume `spectra_data`. O uso atual aparece em `https://SEU-SERVIDOR/api/usage`.

- Para mudar o limite, edite `SPECTRA_MONTHLY_LIMIT_GB` no `server/.env` e rode `sudo ./install.sh` de novo.
- A medição conta todo o tráfego de saída da VM, então fica um pouco acima do que a Oracle cobra. A contagem começa quando o servidor é instalado: confira também o uso no painel da Oracle (*Billing → Cost Analysis*).
- Para o aviso na página de download, crie no GitHub a variável `SPECTRA_SERVER` (*Settings → Secrets and variables → Actions → Variables*) com o endereço do servidor, por exemplo `https://129-146-10-20.sslip.io`, e rode o workflow *Página de download* de novo.

## 2. Usar o app

1. Baixe o `Spectra.exe` pela página ou pela aba *Releases*. Não precisa instalar.
2. Na primeira vez, informe seu nome, o **servidor** e a **chave de acesso**.
3. **Criar uma sala** gera um código; os amigos entram com **Tenho um código**.
4. Para transmitir, ajuste em **Configurações da transmissão**:
   - **Resolução:** 720p, 1080p ou 1440p
   - **FPS:** 30 ou 60
   - **Qualidade:** econômica, equilibrada ou alta (define o bitrate)
   - **Conteúdo:** *jogo/vídeo* prioriza fluidez; *texto/código* prioriza nitidez
   - **Codec:** H.264 (mais compatível, usa a placa de vídeo), VP9 ou AV1 (melhor imagem por bit, pesa mais)
   - **Áudio do computador:** no seletor do Windows, marque “Compartilhar áudio do sistema”
5. Quem assiste escolhe **Máxima / Média / Baixa** no canto do vídeo, ajusta o volume e pode usar tela cheia (duplo clique).

Bitrate de referência com qualidade equilibrada e H.264: 1080p60 ≈ 6,8 Mbps na camada principal e ≈ 8,8 Mbps de upload no total (as três camadas mais o áudio). O painel de configurações mostra a estimativa antes de começar, e a barra inferior avisa se a transmissão estiver limitada pelo processador ou pela internet.

## 3. Desenvolvimento

Requisitos: Windows 10/11, [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) e o WebView2 Runtime (já vem no Windows 11).

```powershell
cd app/Spectra
dotnet run                      # modo Debug: F12 abre o DevTools
dotnet publish -c Release -o out   # gera out/Spectra.exe (arquivo único)
```

A interface está em `app/Spectra/wwwroot` (HTML/CSS/JS puro, sem etapa de build). O SDK do LiveKit fica em `wwwroot/vendor/livekit-client.umd.js` (versão 2.22.4).

Serviço de tokens, local:

```bash
cd server/token
LIVEKIT_API_KEY=dev LIVEKIT_API_SECRET=segredo-com-pelo-menos-32-caracteres SPECTRA_ACCESS_KEY=amigos \
LIVEKIT_PUBLIC_URL=ws://localhost:7880 dotnet run
```

### Publicar uma versão

```bash
git tag v0.1.0
git push origin v0.1.0
```

O workflow **App** compila o `Spectra.exe` no Windows e cria a release. O botão da página baixa sempre a release mais recente, e o app avisa quando há versão nova.

Para a página: em *Settings → Pages*, escolha **Source = GitHub Actions** uma vez.

## Próximos passos

- Chat de texto e voz na sala
- Captura e codificação nativas em C# (Windows.Graphics.Capture + NVENC/QuickSync/AMF) para jogos em 1440p/60 com menos carga, enviando por WHIP
- Assinatura digital do `.exe` (remove o aviso do SmartScreen)
- Login (Discord/Google) e moderação, para abrir além do grupo de amigos
