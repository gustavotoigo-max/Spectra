# Spectra

Transmissão de tela para o seu grupo, no estilo do Discord: um app para Windows em C#, um servidor SFU gratuito e uma página de download.

```
Transmissor (Spectra.exe) ──1 fluxo, 3 camadas──► Servidor SFU ──┬──► Espectador 1 (escolheu 1080p60)
                                                                 ├──► Espectador 2 (escolheu 720p30)
                                                                 └──► Espectador 3 (escolheu 360p15)
```

O servidor pode ser de dois tipos, e o app descobre sozinho qual é pelo endereço configurado:

| Servidor | Custo | Limite do mês | Observação |
| --- | --- | --- | --- |
| **Cloudflare Realtime** (`server/worker`) | grátis até 1.000 GB/mês | o app bloqueia em 900 GB | sem VM; a Cloudflare pede um cartão ou PayPal cadastrado |
| **LiveKit numa VM da Oracle** (`server/`) | grátis (Always Free) | o app bloqueia em 5 TB | a VM ARM grátis vive sem vaga em São Paulo |

Para migrar de um para o outro, basta trocar o endereço do servidor nas configurações do app.

- **Quem transmite envia uma vez só.** O servidor replica para cada espectador, sem recodificar nada.
- **Simulcast:** o transmissor manda 3 versões (por exemplo 1080p60, 720p30 e 360p15) e cada espectador escolhe a que quer receber. Se a internet de alguém piorar, o servidor baixa a qualidade só para essa pessoa.
- **Áudio do computador** em estéreo, 128 kbps, sem cancelamento de eco nem redução de ruído.
- **Ninguém recebe vídeo à toa:** você só baixa a transmissão de quem está assistindo, como no Discord.

## Estrutura

| Pasta | O que é |
| --- | --- |
| `app/Spectra` | App para Windows: WPF + WebView2 (.NET 8). A interface (HTML/CSS/JS) vai embutida no `.exe`: `app-cloudflare.js` (WebRTC direto com o SFU da Cloudflare) e `app-livekit.js` (SDK do LiveKit); o `app.js` carrega o certo. |
| `server/worker` | Servidor na Cloudflare: um Worker (JavaScript, a Cloudflare não roda C#) com as salas (Durable Objects), a chave do grupo, o proxy do SFU e o limite do mês. |
| `server/` | Servidor na VM: LiveKit (SFU), serviço de tokens em C# e Caddy (HTTPS automático), tudo em Docker. |
| `site/` | Página de download (GitHub Pages). |
| `.github/workflows` | Build do `.exe` no Windows, release por tag e publicação da página. |

## 1a. Subir o servidor na Cloudflare (sem VM)

O GitHub publica o Worker sozinho: você só cria as chaves na Cloudflare e guarda como segredos do repositório.

1. Crie uma conta em [dash.cloudflare.com](https://dash.cloudflare.com) e cadastre uma forma de pagamento (cartão ou PayPal). O Realtime exige, mesmo no plano grátis.
2. Abra **Workers & Pages** uma vez. Se pedir, escolha um subdomínio `.workers.dev`.
3. **Realtime → Serverless SFU → Create**: anote o **App ID** e o **App Token**.
4. Copie o **Account ID** (página inicial da conta, à direita).
5. **My Profile → API Tokens → Create Token**, com o modelo **Edit Cloudflare Workers**.
6. No GitHub, em *Settings → Secrets and variables → Actions*, crie os segredos `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_APP_ID`, `CF_APP_TOKEN` e `SPECTRA_ACCESS_KEY` (a senha do grupo, inventada por você).
7. Rode **Actions → Servidor na Cloudflare → Run workflow**. O resumo da execução mostra o endereço do servidor (algo como `https://spectra.seu-nome.workers.dev`). É ele que vai no app.

Opcional: os segredos `TURN_KEY_ID` e `TURN_KEY_TOKEN` (**Realtime → TURN Server → Create**) ajudam quem está em redes muito restritas.

**Limite do mês:** cada app informa ao Worker quanto recebeu do SFU, e o Worker bloqueia novas conexões ao chegar em 900 GB (a Cloudflare cobra só acima de 1.000 GB). Para mudar, crie a variável `SPECTRA_MONTHLY_LIMIT_GB` (aba *Variables*) e rode o workflow de novo. O consumo aparece em `https://SEU-SERVIDOR/api/usage`.

## 1b. Subir o servidor numa VM (grátis, na Oracle Cloud)

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

### Criar a VM automaticamente (quando a Oracle diz "Out of capacity")

As VMs ARM grátis vivem sem vaga. O workflow **Criar VM na Oracle** tenta criar a VM a cada 5 minutos pelo GitHub, sem depender do seu PC nem do Cloud Shell aberto. Quando consegue, ele se desliga e mostra o IP no resumo da execução (aba *Actions*).

1. **Rede:** no Cloud Shell da Oracle (ícone `>_` no painel), envie e rode `server/oracle/criar-rede.sh`. Ele cria a rede `spectra` e já libera as portas do Spectra.
2. **Chave SSH:** no Cloud Shell, rode `ssh-keygen -t rsa -b 4096 -f ~/.ssh/spectra_oci -N ''` (se ainda não tiver) e depois `cat ~/.ssh/spectra_oci.pub`. Copie a linha que aparecer.
3. **Chave de API da Oracle:** no painel, clique no seu perfil (canto superior direito) → *My profile* → *API keys* → **Add API key** → *Generate API key pair* → **Download private key** → **Add**. A tela seguinte mostra um texto com `user=`, `fingerprint=`, `tenancy=` e `region=`.
4. **Segredos no GitHub:** em *Settings → Secrets and variables → Actions → New repository secret*, crie:

   | Segredo | Valor |
   | --- | --- |
   | `OCI_USER` | o `user=` do passo 3 |
   | `OCI_FINGERPRINT` | o `fingerprint=` |
   | `OCI_TENANCY` | o `tenancy=` |
   | `OCI_REGION` | o `region=` (ex.: `sa-saopaulo-1`) |
   | `OCI_KEY` | o conteúdo inteiro do arquivo `.pem` baixado no passo 3 |
   | `SSH_PUBLIC_KEY` | a linha copiada no passo 2 |

5. Em *Actions → Criar VM na Oracle*, clique em **Run workflow** para a primeira tentativa. Depois ele segue sozinho a cada 5 minutos.

Quando a VM sair, entre pelo Cloud Shell com `ssh -i ~/.ssh/spectra_oci ubuntu@IP` e siga o passo 3 da seção acima (`install.sh`). Para tentar de novo no futuro, reative o workflow em *Actions*.

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

É automático: cada push no `main` que muda o app (ou o serviço de tokens) compila o `Spectra.exe` e publica uma Release nova, subindo o último número da versão (0.2.0 → 0.2.1). O botão da página baixa sempre a Release mais recente, e o app avisa quando há versão nova.

Para pular para 0.3.0 ou 1.0.0, mude `<VersionPrefix>` no `app/Spectra/Spectra.csproj`. Uma tag `v*` criada à mão também publica aquela versão.

Para a página: em *Settings → Pages*, escolha **Source = GitHub Actions** uma vez.

## Próximos passos

- Chat de texto e voz na sala
- Captura e codificação nativas em C# (Windows.Graphics.Capture + NVENC/QuickSync/AMF) para jogos em 1440p/60 com menos carga, enviando por WHIP
- Assinatura digital do `.exe` (remove o aviso do SmartScreen)
- Login (Discord/Google) e moderação, para abrir além do grupo de amigos
