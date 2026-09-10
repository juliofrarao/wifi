# Creche Segura

Controle de entrada e saída de crianças em creches. Cada responsável (ou cada
criança) tem uma **carteirinha** com um código impresso, um QR Code e,
opcionalmente, uma etiqueta NFC. Na portaria, a vigilante encosta a carteirinha
no celular, confere a foto na tela e confirma **ENTRADA** ou **SAÍDA**. Em toda
saída, **todos os responsáveis da criança** recebem um alerta no app, por
notificação no celular e por e-mail dizendo quem retirou e a que horas.

Tudo funciona pelo navegador (é um PWA): não precisa de loja de aplicativos,
nem de leitor especial, nem de computador na portaria. O servidor é pequeno e
cabe num VPS barato ou num computador da própria creche.

## Para quem é

| Quem | O que faz no sistema |
| --- | --- |
| **Direção / secretaria** (`admin`) | Cadastra crianças, responsáveis e equipe; emite e imprime carteirinhas; vê o painel, os alertas de exceção, relatórios e auditoria; lança a folha de papel; importa planilha; faz backup. |
| **Vigilante / portaria** (`guard`) | Lê carteirinhas, confirma entradas e saídas, registra recusas e exceções, cancela um registro errado, vê quem está na creche e imprime a folha de presença. |
| **Pais e responsáveis** (`guardian`) | Veem o status e o histórico dos filhos, recebem os alertas, autorizam alguém a buscar hoje, escolhem como querem ser avisados. |

Uma pessoa pode ser responsável por vários filhos (irmãos) e uma criança pode
ter vários responsáveis. Quem não tem e-mail nem celular pode ser cadastrado só
para ser reconhecido na portaria.

## Como funciona

| Situação | O que acontece |
| --- | --- |
| **Entrada** | A vigilante lê a carteirinha, vê quem é e quais filhos estão vinculados, e toca em **ENTRADA**. Fica registrado quem deixou, a hora e quem registrou. Os responsáveis recebem aviso no app (push e e-mail conforme a preferência de cada um). |
| **Saída** | A vigilante lê a carteirinha, confere a **foto** de quem está buscando e toca em **SAÍDA**. Só pode retirar quem está na lista de autorizados da criança. Todos os responsáveis recebem o alerta "Saída registrada — Ana e Pedro saíram às 17:32 com Maria Silva (mãe)". |
| **Alerta** | Cada confirmação gera um alerta por responsável: no app sempre; push se a pessoa ativou; e-mail se tem e-mail cadastrado. Irmãos vão num alerta só. |
| **Exceção** | Alguém fora da lista (ou não cadastrado) vem buscar. A vigilante confere o documento, escreve o motivo e registra a saída como **exceção**: os responsáveis e a direção recebem "ATENÇÃO — retirada fora da lista de autorizados". Se a pessoa está **bloqueada** (decisão judicial ou da direção), a tela fica vermelha, "NÃO LIBERAR", e a tentativa é registrada como recusa. |
| **Autorização avulsa** | "Hoje a vizinha busca." O responsável (pelo app) ou a secretaria registra nome, relação e validade. A portaria vê a pessoa na lista da criança e registra a saída normalmente; o alerta diz "autorizada por Maria (mãe)". |
| **Desfazer** | Toda confirmação tem 45 segundos de **Desfazer** antes de qualquer alerta sair. Depois disso, a vigilante (até 24 h) ou a direção (sempre) pode **cancelar** o registro com um motivo; os responsáveis recebem "Registro cancelado". Nada é apagado. |
| **Sem internet** | O celular da portaria guarda os cadastros e as fotos localmente. Os registros entram numa fila e são enviados quando a conexão volta. |
| **Folha de papel** | Se o celular falhar, a portaria imprime a folha de presença do dia e a secretaria digita depois em "Lançar folha". |

## O que é preciso

- **Um celular Android com Chrome e NFC** para a portaria (NFC é opcional:
  qualquer celular com câmera lê o QR Code, e o código também pode ser
  digitado ou a pessoa buscada pelo nome). Carregador e capa recomendados.
- **Um servidor pequeno** com endereço na internet e HTTPS: um VPS barato
  (1 vCPU, 1 GB de RAM) ou um computador na creche com Cloudflare Tunnel.
  Veja [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md).
- **Carteirinhas**: papel plastificado com QR Code (impressas pelo próprio
  sistema, 10 por folha A4) e, se quiser NFC, etiquetas NTAG213 adesivas.
  Veja [docs/CARTEIRINHAS.md](docs/CARTEIRINHAS.md).
- **Uma conta de e-mail** para enviar os alertas (Gmail com senha de app,
  Brevo ou Amazon SES). Sem e-mail o sistema funciona; os convites saem por
  WhatsApp ou QR e os alertas vão por push e pelo app.
- Para os responsáveis: qualquer celular (Android ou iPhone) com navegador.

## Início rápido — desenvolvimento

Pré-requisitos: Node.js 22 ou mais novo e npm.

```bash
npm install        # instala tudo e compila o pacote shared
npm run seed       # cria o banco com dados de demonstração (fictícios)
npm run dev        # sobe a API em http://localhost:3000 e o app em http://localhost:5173
```

Abra <http://localhost:5173/login>. O banco fica em `server/data/creche.sqlite`
(fotos em `server/data/uploads/`, backups em `server/data/backups/`). Sem
`.env` os padrões servem; para mudar algo copie `.env.example` para `.env` na
raiz do repositório. Se preferir começar **sem** os dados de demonstração,
crie o `.env` com `ADMIN_EMAIL` e `ADMIN_PASSWORD` (12 caracteres ou mais)
antes do `npm run dev` — sem nenhum administrador o servidor se recusa a
iniciar.

Contas de demonstração criadas pelo `npm run seed`:

| Papel | Acesso |
| --- | --- |
| Administração | `admin@demo.local` / `demo-admin-123` |
| Portaria | login `carlos` / senha `demo-guard-123` / PIN `1234` |
| Portaria | login `ana` / senha `demo-guard-123` / PIN `5678` |
| Responsável (dois filhos: Ana e Pedro) | `maria@demo.local` / `demo-maria-123` |
| Outros responsáveis com senha | `fernanda`, `patricia`, `camila`, `aline`, `beatriz`, `claudia`, `juliana`, `simone` — `<nome>@demo.local` / `demo-<nome>-123` |

Carteirinhas de demonstração (código impresso): `AAAA-2222` = Maria Silva,
`BBBB-3333` = João Souza, `CCCC-4444` = Fernanda Oliveira, … ; crianças:
`AAAA-6666` = Ana Souza, `BBBB-7777` = Pedro Souza, `CCCC-8888` = Lucas
Oliveira, … ; `AAAA-9999` = carteirinha antiga de Maria, **revogada**. O
comando imprime a lista completa no terminal.

Um roteiro para experimentar: entre como `carlos` → **Digitar código** →
`AAAA-2222` → confirme a **ENTRADA** de Ana e Pedro → toque em **Desfazer** →
confirme de novo → depois confirme a **SAÍDA** → entre como Maria e veja os
alertas (eles saem 45 s após a confirmação). No painel, `admin@demo.local` vê o
dia no relatório. A demonstração também inclui uma criança sem saída registrada
ontem (Gabriel), uma sem foto (Sofia), um pai bloqueado com aviso de portaria
(Davi), um vínculo vencido (tia de Miguel), uma exceção, uma recusa e um
conflito da fila.

O banner "DADOS DE DEMONSTRAÇÃO" fica visível até você rodar
`npm run seed -- --clean`. O seed se recusa a rodar num banco com dados reais
(use `-- --force` só se souber o que está fazendo).

Dicas:

- O service worker (modo offline, push, "instalar na tela inicial") só é
  registrado na versão compilada: `npm run build && npm start` serve o app em
  <http://localhost:3000>.
- NFC, câmera e push exigem HTTPS ou `localhost`. Para testar num celular
  Android ligado por USB use `adb reverse tcp:5173 tcp:5173` (e
  `tcp:3000` no modo compilado) e abra `http://localhost:5173` no Chrome do
  celular.

## Início rápido — produção

Resumo (o passo a passo completo, com e-mail, push, backup e solução de
problemas, está em [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md)):

```bash
cp .env.example .env                 # edite: APP_URL, DOMAIN, ADMIN_*, SMTP_*, TZ
mkdir -p data && sudo chown -R 1000:1000 data   # pasta do banco, fotos e backups
docker compose up -d --build         # servidor + Caddy (HTTPS automático)
docker compose logs -f app           # "Creche Segura no ar"
```

Aponte o DNS do seu domínio para o servidor antes de subir. Na primeira
execução o sistema cria o banco, gera as chaves de push e cria o administrador
de `ADMIN_EMAIL` / `ADMIN_PASSWORD` (a senha precisa ter 12 caracteres ou mais e
ser diferente da do exemplo, senão o servidor não inicia). Entre em
`https://<seu-domínio>/login`.

## Estrutura do repositório

```
shared/        contrato da API (DTOs, validações zod, códigos de erro, helpers de data e carteirinha)
server/        API Fastify + SQLite (better-sqlite3), e-mail, push, jobs, seed, purge, restore
  src/db/schema.sql   esquema do banco (fonte da verdade)
  src/README.md       mapa dos módulos do servidor
  test/               testes (node:test, banco em memória)
web/           PWA (Vite + React 19): app da portaria, dos responsáveis e painel da administração
  src/README.md       mapa das telas e componentes
  public/sw.js        service worker
e2e/           teste ponta a ponta (Playwright)
docs/          esta documentação
Dockerfile, docker-compose.yml, Caddyfile, .env.example
```

## Comandos

Na raiz do repositório:

| Comando | O que faz |
| --- | --- |
| `npm install` | Instala as dependências e compila `shared/`. |
| `npm run dev` | Desenvolvimento: `shared` em modo watch, API em `:3000` (tsx watch) e app em `:5173` (Vite, com proxy de `/api`). |
| `npm run build` | Compila `shared`, `server` (para `server/dist`) e `web` (para `web/dist`). |
| `npm start` | Sobe o servidor compilado (`node server/dist/index.js`), que também serve o app. |
| `npm run seed` | Dados de demonstração. Opções: `-- --clean` remove só os dados de demonstração; `-- --force` semeia mesmo com dados reais. |
| `npm run typecheck` | `tsc --noEmit` nos três pacotes. |
| `npm test` | Testes unitários e de API dos três pacotes. |
| `npm run test:e2e` | Ponta a ponta com Playwright/Chromium (`e2e/run.ts`: sobe o servidor **compilado** com o seed numa pasta temporária e percorre portaria, responsável e painel). Rode `npm run build` antes e instale o navegador uma vez: `npx playwright install chromium`. |
| `npm run purge -w server` | Retenção LGPD: anonimiza crianças desligadas há mais de `RETENTION_MONTHS` (24) meses, apaga tentativas de login com mais de 24 h e números de documento com mais de 12 meses. |
| `npm run restore -w server -- /caminho/creche-AAAA-MM-DD-HHmm.sqlite --yes` | Restaura um backup (com o servidor parado; o banco atual é preservado como `creche.sqlite.before-restore-<data>`). |

Em produção (Docker) os mesmos scripts rodam compilados:
`docker compose exec app node server/dist/seed.js`, `node server/dist/purge.js`,
`node server/dist/restore.js`.

## Documentação

- [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md) — hospedagem, domínio e HTTPS, variáveis de ambiente, e-mail, push, backup e restauração, atualização, retenção, solução de problemas.
- [docs/CARTEIRINHAS.md](docs/CARTEIRINHAS.md) — carteirinha de responsável e de criança, geração em lote, impressão, etiquetas NFC, perda e revogação.
- [docs/PORTARIA.md](docs/PORTARIA.md) — guia de uma página para a vigilante.
- [docs/RESPONSAVEIS.md](docs/RESPONSAVEIS.md) — guia para pais e responsáveis.
- [docs/LGPD.md](docs/LGPD.md) — proteção de dados, consentimento, retenção e modelo de termo.
- [docs/ESPECIFICACAO.md](docs/ESPECIFICACAO.md) — especificação completa (regras de negócio, telas, API).
- [server/src/README.md](server/src/README.md) e [web/src/README.md](web/src/README.md) — para quem vai manter o código.

## Limitações conhecidas

- **NFC só no Chrome para Android.** iPhone não lê etiquetas pelo navegador;
  use o QR Code (a câmera do celular da portaria) ou digite o código.
- **iPhone dos responsáveis**: as notificações push só chegam com o app
  instalado na tela inicial (iOS 16.4 ou mais novo). Sem isso, os alertas ficam
  no app e no e-mail.
- **Fila offline só é enviada com o app aberto** (não usa Background Sync).
  Saída sem conexão exige um segundo toque e é recusada se os dados locais
  tiverem mais de 12 h.
- **Um servidor = uma creche**, um fuso horário. Não há multiunidade nem
  integração com sistemas da secretaria de educação.
- **Sem SMS nem WhatsApp oficial.** O link de convite pode ser enviado pelo
  WhatsApp da secretaria (abre o `wa.me` já com o texto), só isso.
- **E-mail depende do provedor**: Gmail gratuito ~500/dia, Brevo gratuito
  300/dia. Ao atingir `SMTP_DAILY_LIMIT`, e-mails de rotina são pulados e só
  as exceções continuam saindo por e-mail (push e app não são afetados).
- **Backups ficam no próprio servidor** (`data/backups/`, 14 dias). Copie para
  fora regularmente; o botão "Baixar último backup" precisa do utilitário `tar`
  no servidor. `npm run restore` restaura só o banco; as fotos (`uploads/`)
  são copiadas à mão.
- **Importar planilha** cria cadastros e vínculos; não altera nem remove os
  existentes.
- **A etiqueta NFC e o código não são segredos.** A segurança vem da foto
  conferida pela vigilante, da lista de autorizados, do alerta a todos os
  responsáveis e do registro de recusas e exceções.
- Fora de escopo por enquanto: app nativo, reconhecimento facial, foto de
  evidência na exceção, confirmação de recebimento do push, lista de feriados.
