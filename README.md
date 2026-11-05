# Spectra

Transmissão de tela para o seu grupo, no estilo do Discord: um app para Windows em C#, um servidor gratuito na Cloudflare e uma página de download.

```
Transmissor (Spectra.exe) ──1 fluxo, 3 camadas──► Cloudflare Realtime SFU ──┬──► Espectador 1 (escolheu Máxima)
                                                                            ├──► Espectador 2 (escolheu Média)
                                                                            └──► Espectador 3 (escolheu Baixa)
```

- **Quem transmite envia uma vez só.** O SFU da Cloudflare replica para cada espectador, sem recodificar nada.
- **Simulcast:** o transmissor manda 3 versões (por exemplo 1080p60, 720p30 e 360p15) e cada espectador escolhe a que quer receber. Se a internet de alguém piorar, o SFU baixa a qualidade só para essa pessoa.
- **Áudio do computador** em estéreo, 128 kbps, sem cancelamento de eco nem redução de ruído. O microfone nunca é usado.
- **Ninguém recebe vídeo à toa:** você só baixa a transmissão de quem está assistindo, como no Discord. Sem ninguém assistindo, o transmissor manda só a camada mais leve.

## Estrutura

| Pasta | O que é |
| --- | --- |
| `app/Spectra` | App para Windows: WPF + WebView2 (.NET 8). A interface (HTML/CSS/JS) vai embutida no `.exe`; a captura e o WebRTC usam o motor do próprio WebView2. |
| `server/worker` | Servidor: um Cloudflare Worker (JavaScript, a Cloudflare não roda C#) com as salas (Durable Objects), a chave de acesso do grupo e o proxy para a API do SFU. |
| `site/` | Página de download (GitHub Pages). |
| `.github/workflows` | Build do `.exe` no Windows, release por tag, checagem do Worker e publicação da página. |

## 1. Subir o servidor (grátis, na Cloudflare)

O plano gratuito da Cloudflare inclui **1.000 GB por mês** de tráfego do SFU/TURN (o upload de quem transmite não conta) e os Durable Objects usados pelas salas. Um 1080p60 gasta cerca de 3 GB por hora por espectador, então dá umas 330 horas-espectador por mês. Só quem monta o servidor precisa de conta; os amigos só usam o app.

1. Crie uma conta grátis em [dash.cloudflare.com](https://dash.cloudflare.com).
2. No painel, vá em **Realtime → Serverless SFU → Create** e anote o **App ID** e o **App Token**.
3. (Opcional, para redes muito restritas) Em **Realtime → TURN Server → Create**, anote o **Turn Token ID** e o **API Token**.
4. Num computador com [Node.js](https://nodejs.org) 20 ou mais novo:

   ```bash
   git clone https://github.com/gustavotoigo-max/Spectra.git
   cd Spectra/server/worker
   npm install
   npx wrangler login                          # abre o navegador para autorizar
   npx wrangler deploy                         # publica e mostra o endereço
   npx wrangler secret put CF_APP_ID           # cole o App ID
   npx wrangler secret put CF_APP_TOKEN        # cole o App Token
   npx wrangler secret put SPECTRA_ACCESS_KEY  # invente a chave do grupo (longa)
   # opcionais, para TURN:
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_TOKEN
   ```

   O endereço do servidor é o que o `deploy` mostrou, algo como `https://spectra.seu-nome.workers.dev`. Abra `…/api/health` no navegador: deve aparecer `"configured": true`.

Para atualizar depois: `git pull && npx wrangler deploy` (os segredos são mantidos).

Os segredos ficam só na Cloudflare. A chave de acesso protege o servidor: quem não tem a chave não entra nas salas nem usa o SFU.

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

A interface está em `app/Spectra/wwwroot` (HTML/CSS/JS puro, sem etapa de build, sem bibliotecas externas: usa o WebRTC do próprio WebView2).

Servidor, local (salas e chave funcionam; a mídia precisa de um App do SFU de verdade):

```bash
cd server/worker
npm install
printf 'CF_APP_ID=...\nCF_APP_TOKEN=...\nSPECTRA_ACCESS_KEY=amigos\n' > .dev.vars
npx wrangler dev        # http://localhost:8787
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
- Captura e codificação nativas em C# (Windows.Graphics.Capture + NVENC/QuickSync/AMF) para jogos em 1440p/60 com menos carga e para escolher o áudio de um app específico
- Assinatura digital do `.exe` (remove o aviso do SmartScreen)
- Login (Discord/Google) e moderação, para abrir além do grupo de amigos
