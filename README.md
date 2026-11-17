# Bloxr

Laboratório de IA para Kaggle e Colab, pronto para GitHub Pages. Frontend sem servidor e sem dependência do ChatGPT.

## Conexão

Abra Conexões, informe seu usuário Kaggle e token KGAT_ (ou chave antiga kaggle.json). O teste usa ListKernels no serviço oficial do Kaggle diretamente do navegador. Não cole credenciais no repositório. O token fica em sessionStorage na aba do usuário e é enviado somente à API oficial Kaggle.

Cada envio inicia um notebook privado separado no Kaggle. Não controla automaticamente uma sessão interativa aberta. O Coder 7B Q4 usa duas GPUs. O fluxo visual atual requer endpoint compatível; envio de imagem direto a notebooks Kaggle ainda não está implementado.

## Publicação

GitHub Settings → Pages → Deploy from a branch → main → / (root). GitHub Free exige repositório público para Pages. Nenhum arquivo de credencial deve ser publicado.

## Validação

npm test

O teste de preflight CORS da API oficial respondeu permitindo origem https://sakilruan-byte.github.io, método POST e cabeçalhos authorization/content-type em 17/11/2026. Isso confirma a permissão do navegador, mas não uma autenticação com token real nem execução GPU.
