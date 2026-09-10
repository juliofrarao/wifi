# Creche Segura — Especificação do sistema

Controle de entrada e saída de crianças em creches, com carteirinha NFC/QR,
app para a portaria (vigilante), app para os responsáveis e painel para a
administração. Todo o texto da interface é em português do Brasil.

## 1. Visão geral

**Problema.** A creche não registra quem deixa nem quem busca cada criança,
nem em que horário. Os responsáveis não têm como saber, na hora, com quem a
criança saiu.

**Solução.** Cada responsável (e opcionalmente cada criança) recebe uma
carteirinha com uma etiqueta NFC e um QR Code. Na portaria, a vigilante
aproxima a carteirinha do próprio celular (ou lê o QR, ou digita o código):

1. **Entrada (chegada):** fica registrado qual responsável deixou a criança,
   com data e hora, e quem registrou.
2. **Saída (busca):** fica registrado quem retirou a criança, com data e hora,
   e **todos os responsáveis da criança** recebem um alerta no app e por
   e-mail informando quem retirou e quando.

**Princípios de projeto.**

- Rápido na portaria: identificar + confirmar em dois toques, com tela grande e
  legível ao sol.
- Seguro por padrão: quem retira precisa estar na lista de autorizados; a
  vigilante confere a foto na tela; toda exceção fica registrada e gera alerta.
- Barato de implantar: um servidor pequeno (VPS ou computador na creche), sem
  loja de aplicativos (PWA), etiquetas NFC comuns (NTAG213) ou só QR impresso.
- Funciona sem NFC: leitura por QR Code (câmera), código digitado ou busca por
  nome, para celulares sem NFC (ex.: iPhone na portaria) ou carteirinha
  danificada.
- Continua funcionando com internet ruim: o app da portaria guarda os registros
  numa fila e envia quando a conexão volta.

## 2. Papéis

| Papel | Quem | O que faz |
| --- | --- | --- |
| `admin` (administração) | direção / secretaria | Cadastra crianças, responsáveis, vigilantes; emite carteirinhas; vê relatórios; registra ajustes manuais. |
| `guard` (vigilante / portaria) | quem fica no portão | Lê carteirinhas, confirma entradas e saídas, vê quem está na creche agora, registra saída manual com foto/documento. |
| `guardian` (responsável) | pais, mães, avós, tios autorizados | Vê status e histórico dos filhos, recebe alertas (push + e-mail), gerencia preferências e senha. |

Uma conta tem exatamente um papel. Um responsável pode estar vinculado a várias
crianças (irmãos). Uma criança pode ter vários responsáveis.

## 3. Conceitos

- **Criança**: nome, data de nascimento, turma, foto, observações.
- **Responsável**: usuário com papel `guardian`; nome, e-mail (obrigatório —
  é o canal de alerta), telefone, foto (usada pela vigilante para conferir a
  pessoa).
- **Vínculo (criança ⇄ responsável)**: parentesco (mãe, pai, avó, tio, outro),
  `podeRetirar` (autorizado a buscar), `principal` (contato principal),
  `validoAte` (opcional; autorização temporária, ex.: avó nesta semana).
- **Credencial (carteirinha)**: identificador físico ligado a um responsável
  **ou** a uma criança. Dois tipos:
  - `code`: código curto de 8 caracteres (ex.: `7K3P-2Q9M`), impresso na
    carteirinha como texto e como QR Code (URL `https://<app>/c/7K3P2Q9M`) e,
    opcionalmente, gravado na etiqueta NFC como registro NDEF de URL.
  - `nfc_uid`: número de série (UID) da etiqueta NFC, lido pelo celular. Permite
    usar etiquetas em branco, sem gravar nada.
  Uma pessoa pode ter várias credenciais ativas (ex.: uma carteirinha + uma
  tag no chaveiro). Credencial perdida é **revogada** (nunca apagada).
- **Evento de presença**: `checkin` (entrada) ou `checkout` (saída) de uma
  criança, com: responsável (ou nome da pessoa, se não cadastrada), vigilante
  que registrou, método (`nfc`, `qr`, `code`, `manual`), credencial usada,
  horário, observação, flag `override` (exceção autorizada manualmente).
- **Status da criança**: derivado do último evento: *na creche* (último evento
  é `checkin`) ou *fora* (último é `checkout` ou nenhum).
- **Notificação**: registro de envio de um evento para um responsável por um
  canal (`inapp`, `push`, `email`), com status.

## 4. Fluxos

### 4.1 Identificação na portaria

Ordem de tentativa, todas levam à mesma tela de confirmação:

1. **NFC** — Chrome no Android com NFC (API Web NFC). A tela de leitura fica
   "ouvindo"; ao aproximar a carteirinha o app recebe o UID e, se houver, o
   registro NDEF (URL/texto com o código).
2. **QR Code** — câmera do celular (API `BarcodeDetector`, com fallback em
   JavaScript). Funciona em qualquer celular, inclusive iPhone.
3. **Código digitado** — campo `XXXX-XXXX`; aceita minúsculas e sem hífen.
4. **Busca por nome** — lista de responsáveis e crianças; uso excepcional (sem
   carteirinha), registrado como método `manual`.

O app envia `{ uid?, code? }` para `POST /api/scan/lookup`. O servidor procura
primeiro pelo código, depois pelo UID. Se nada for encontrado: "Carteirinha não
reconhecida" com opção de buscar por nome.

### 4.2 Carteirinha de responsável (fluxo principal)

Ao identificar um **responsável**, a tela de confirmação mostra:

- foto grande, nome e parentesco do responsável;
- lista das crianças vinculadas, cada uma com foto, nome, turma, status atual
  ("Na creche desde 07:45" / "Fora") e um checkbox;
- a ação sugerida: **ENTRADA** se nenhuma criança marcada está na creche,
  **SAÍDA** se todas estão. Se estiver misto (ex.: um irmão já saiu), as
  crianças coerentes com a ação sugerida ficam pré‑marcadas e a vigilante
  ajusta;
- um botão grande: verde "Registrar ENTRADA" ou laranja "Registrar SAÍDA".
  Há um seletor para trocar a ação.

Na **saída**, se o responsável não tem `podeRetirar` para alguma criança
marcada (ou a autorização venceu), essa criança aparece em vermelho "NÃO
AUTORIZADO A RETIRAR" e o botão fica bloqueado para ela. A vigilante pode
desmarcá‑la ou usar a exceção (4.4).

### 4.3 Carteirinha de criança

Ao identificar uma **criança**, a tela mostra a foto/nome da criança e a lista
dos responsáveis vinculados (foto, nome, parentesco, selo "pode retirar"). A
vigilante toca em quem está presente e segue para a confirmação de 4.2 com
apenas essa criança. Há também "Outra pessoa (não cadastrada)" → 4.4.

### 4.4 Pessoa não autorizada ou não cadastrada (exceção)

Só na **saída**. A vigilante informa nome completo da pessoa, documento e o
motivo (ex.: "mãe ligou autorizando, direção ciente"). O evento é gravado com
`override = true`, `personName` preenchido (ou `guardianId` do responsável sem
autorização) e a observação. Todos os responsáveis recebem alerta destacado:
"**ATENÇÃO**: retirada por pessoa fora da lista de autorizados". A direção vê
essas exceções em destaque no painel. Na **entrada** não existe exceção: quem
deixa a criança pode ser qualquer responsável vinculado, ou "outra pessoa" com
nome — sem bloqueio, pois não há risco de retirada.

### 4.5 Sem conexão (fila do app da portaria)

O app da portaria mantém em cache local a lista de credenciais, responsáveis e
crianças (atualizada a cada abertura e a cada 5 min). Se a rede cair, a leitura
continua funcionando pelo cache e os registros entram numa **fila local**
(IndexedDB/localStorage) com `clientId` (UUID) e `occurredAt` do momento da
confirmação. Quando a conexão volta, a fila é enviada em ordem; o servidor usa
`clientId` para nunca duplicar. A tela mostra "1 registro aguardando envio".

### 4.6 Cadastro e convite de responsáveis

A administração cadastra o responsável (nome, e-mail, telefone, parentesco) ao
cadastrar a criança. O sistema envia um **convite por e-mail** com link para
criar a senha (token válido por 7 dias; pode ser reenviado). Sem e-mail
configurado no servidor, o link do convite é exibido na tela do admin para ser
enviado por outro meio (WhatsApp, papel). "Esqueci minha senha" funciona pelo
mesmo mecanismo.

### 4.7 Emissão de carteirinhas

Na tela da criança (ou do responsável), a administração:

1. **Gera um código** (credencial `code`) — o servidor cria um código único.
2. **Imprime a carteirinha** — página de impressão com nome, foto, turma,
   nome da creche, o código em texto e QR Code, e um espaço marcado para colar
   a etiqueta NFC.
3. **Vincula a etiqueta NFC** (opcional, no Chrome Android) — "Ler etiqueta"
   captura o UID e cria a credencial `nfc_uid`. "Gravar código na etiqueta"
   escreve a URL do código na etiqueta (assim qualquer celular que encoste na
   etiqueta abre a página pública "carteirinha encontrada").
4. **Revoga** credenciais perdidas.

## 5. Regras de negócio

- **R1.** Uma criança só pode ter entrada registrada se estiver *fora*; só pode
  ter saída se estiver *na creche*. Estado divergente → HTTP 409 com o status
  atual; o app mostra o status real e oferece a ação correta.
- **R2.** Registro de saída exige responsável com `podeRetirar = true` e
  autorização não vencida, **ou** `override = true` com `note` obrigatória (e
  `personName` quando a pessoa não é cadastrada).
- **R3.** Registro de entrada aceita qualquer responsável vinculado à criança,
  ou `personName` livre; nunca bloqueia.
- **R4.** Idempotência: `clientId` único por evento; reenvio devolve o evento
  já gravado (HTTP 200), sem duplicar nem notificar de novo.
- **R5.** Duplo toque: se a mesma credencial gerar o mesmo tipo de evento para
  a mesma criança em menos de 60 s, o servidor devolve o evento existente.
- **R6.** `occurredAt` enviado pelo app é aceito até 24 h no passado (fila
  offline); nunca no futuro (usa o horário do servidor se vier inválido).
- **R7.** Um evento nunca é apagado. Correção = novo evento com observação
  (`method = manual`), feito por admin ou vigilante. Só admin pode registrar
  evento com `occurredAt` explícito arbitrário (ex.: "esqueceram de registrar
  a saída ontem").
- **R8.** Toda saída gera notificações para **todos** os responsáveis
  vinculados à criança (inclusive quem retirou — serve de comprovante):
  `inapp` sempre, `push` se houver inscrição, `email` sempre.
- **R9.** Toda entrada gera `inapp` sempre; `push` e `email` conforme
  preferência do responsável (push: padrão ligado; e-mail: padrão desligado).
- **R10.** Vigilante só lê dados necessários para a portaria (nomes, fotos,
  parentesco, autorização, status). Não vê e-mails/telefones dos responsáveis
  nem edita cadastros. Admin vê tudo. Responsável vê apenas os próprios filhos
  e os nomes/parentescos dos outros responsáveis desses filhos.
- **R11.** Credencial revogada ou pessoa inativa: `lookup` responde 404 com
  motivo ("carteirinha revogada"), e o evento é recusado.
- **R12.** Criança que ficou "na creche" de um dia anterior (sem saída) aparece
  com aviso na tela "Hoje" e no relatório de pendências.
- **R13.** Senhas: mínimo 8 caracteres; hash com scrypt; sessões de 30 dias
  renováveis; limite de tentativas de login (5 por 15 min por e-mail/IP).
- **R14.** Horários armazenados em UTC (ISO 8601) e exibidos no fuso da creche
  (`TZ`, padrão `America/Sao_Paulo`).

## 6. Notificações

**Conteúdo (saída):**

> **Saída registrada — João Silva**
> João saiu da creche às 17:32 (10/09/2026) com **Maria Silva (mãe)**.
> Registrado por: Carlos (portaria). Entrada hoje às 07:45.

**Conteúdo (exceção):**

> **ATENÇÃO — retirada fora da lista de autorizados**
> João Silva saiu às 17:32 com **Ana Souza (não cadastrada)**, documento
> 123.456.789-00. Motivo: "mãe ligou autorizando". Registrado por Carlos.
> Se você não reconhece esta retirada, entre em contato com a creche
> imediatamente: (xx) xxxx-xxxx.

**Canais.**

- `inapp`: feed no app do responsável com badge de não lidos.
- `push`: Web Push (VAPID). Android/Chrome funciona direto; iPhone exige iOS
  16.4+ e app instalado na tela inicial. O service worker mostra a
  notificação e, ao tocar, abre o feed.
- `email`: SMTP via nodemailer; se não configurado, fica registrado como
  `skipped` e o painel do admin avisa. Envio assíncrono com uma nova tentativa
  em caso de falha; falhas ficam visíveis no painel.

**Preferências do responsável:** `notifyCheckinPush` (padrão ligado),
`notifyCheckinEmail` (padrão desligado). Alertas de saída não podem ser
desligados.

## 7. Telas

### Portaria (vigilante)

1. **Leitura** — área grande "Aproxime a carteirinha", indicador de estado do
   NFC (ativo / indisponível: "use o Chrome no Android"), botões "Ler QR Code",
   "Digitar código", "Buscar por nome"; contador "N crianças na creche";
   indicador de fila offline.
2. **Confirmação** — descrita em 4.2/4.3.
3. **Sucesso** — tela cheia verde (entrada) ou laranja (saída) com nome(s) e
   horário; volta sozinha para Leitura em 3 s.
4. **Hoje** — crianças na creche (foto, nome, turma, hora de entrada, quem
   deixou), busca, aviso para entradas de dias anteriores; ação rápida
   "Registrar saída" manual (escolhe responsável autorizado ou exceção).
5. **Histórico** — eventos do dia (e dias anteriores), com filtros.

### Responsável

1. **Início** — um card por filho: "Na creche desde 07:45 · deixado por Maria
   (mãe)" ou "Fora da creche · saiu 17:30 com João (pai)"; badge de alertas.
2. **Alertas** — feed de eventos dos filhos, mais recente primeiro; exceções
   em destaque; marca como lido ao abrir.
3. **Filho** — histórico completo e lista de responsáveis autorizados.
4. **Configurações** — ativar notificações no celular (botão que pede
   permissão e registra a inscrição push), preferências de e-mail, foto do
   perfil, trocar senha, sair.

### Administração

1. **Painel** — na creche agora, entradas/saídas de hoje, exceções recentes,
   pendências (sem saída), status do e-mail/push.
2. **Crianças** — lista com busca/filtro por turma; cadastro; foto;
   responsáveis vinculados (adicionar existente ou novo, parentesco, pode
   retirar, principal, validade); credenciais (gerar código, vincular NFC,
   imprimir, revogar); histórico.
3. **Responsáveis** — lista; cadastro; foto; reenviar convite/redefinir senha;
   filhos vinculados; credenciais.
4. **Equipe** — vigilantes e administradores (criar, desativar, redefinir
   senha).
5. **Carteirinhas** — visão geral das credenciais; impressão em lote.
6. **Relatórios** — por dia (entrada, saída, quem, duração), por criança, por
   período; exportar CSV; pendências.
7. **Configurações** — nome e telefone da creche; teste de e-mail; estado das
   chaves push.

### Páginas públicas

- `/login`, `/convite/:token`, `/redefinir/:token`.
- `/c/:code` — "Carteirinha da Creche X. Se você encontrou esta carteirinha,
  entregue na creche ou ligue (xx)". Não revela nome nem dados da pessoa.
  Se a vigilante estiver logada, esta rota abre direto a confirmação.

## 8. Arquitetura e stack

- **Monorepo npm workspaces**: `shared/` (tipos e validação), `server/`,
  `web/`. Node.js 22+, TypeScript, ESM.
- **Servidor**: Fastify 5; SQLite (better-sqlite3) em `DATA_DIR`; nodemailer
  (SMTP); web-push (VAPID, chaves geradas na primeira execução e guardadas no
  banco); uploads de fotos em `DATA_DIR/uploads` (redimensionadas no
  navegador antes do envio, máx. 512 px); serve a PWA compilada em produção.
- **Web**: Vite + React 19 + TypeScript, react-router 7, CSS próprio (sem
  framework de UI), PWA (manifest + service worker próprio com push e cache
  do app), Web NFC, BarcodeDetector + jsQR, `qrcode` para impressão.
- **Autenticação**: token opaco (Bearer) guardado no `localStorage`; sessões
  no banco (hash do token); logout revoga.
- **Um único origin** em produção: o servidor entrega `/api/*`, `/uploads`
  (com autenticação) e a PWA. Em desenvolvimento o Vite faz proxy de `/api`.

## 9. Modelo de dados (SQLite)

Ver `server/src/db/schema.sql`. Resumo:

- `users` (id, name, email único, phone, role, password_hash, photo_file_id,
  active, notify_checkin_push, notify_checkin_email, timestamps)
- `children` (id, name, birth_date, class_name, notes, photo_file_id, active,
  timestamps)
- `child_guardians` (child_id, user_id, relationship, can_pickup, is_primary,
  valid_until)
- `credentials` (id, owner_type, owner_id, kind, value único, label, active,
  revoked_at, timestamps)
- `attendance_events` (id, client_id único, child_id, type, guardian_id,
  person_name, guard_id, method, credential_id, override, note, occurred_at,
  created_at)
- `notifications` (id, user_id, event_id, channel, status, error, read_at,
  sent_at, created_at)
- `push_subscriptions` (id, user_id, endpoint único, p256dh, auth, user_agent)
- `sessions` (id, token_hash único, user_id, expires_at, last_seen_at)
- `auth_tokens` (id, user_id, kind invite|reset, token_hash, expires_at,
  used_at)
- `files` (id, mime, size, path, created_by)
- `settings` (key, value) — chaves VAPID, nome/telefone da creche.

## 10. API

Contrato completo (tipos e validação) em `shared/src/index.ts`. Todas as rotas
sob `/api`, JSON, `Authorization: Bearer <token>` exceto as públicas. Erros:
`{ error: { code, message, details? } }` com HTTP 400/401/403/404/409/429/500.

| Método e rota | Papel | Descrição |
| --- | --- | --- |
| `GET /config` | público | nome da creche, fuso, chave pública VAPID, e-mail habilitado |
| `POST /auth/login` | público | `{email, password}` → `{token, user}` |
| `POST /auth/logout` | todos | revoga a sessão |
| `GET /auth/me` | todos | usuário atual |
| `POST /auth/accept-invite` | público | `{token, password}` → `{token, user}` |
| `POST /auth/forgot-password` | público | `{email}` → 204 sempre |
| `POST /auth/reset-password` | público | `{token, password}` |
| `POST /auth/change-password` | todos | `{currentPassword, newPassword}` |
| `GET /public/cards/:code` | público | nome da creche + telefone (sem dados pessoais) |
| `GET /users?role=` | admin | lista equipe/responsáveis |
| `POST /users` | admin | cria usuário (qualquer papel); sem senha → convite |
| `PATCH /users/:id` | admin | edita; `active:false` desativa |
| `POST /users/:id/invite` | admin | (re)envia convite; devolve `inviteUrl` se e-mail desligado |
| `POST /users/:id/photo` | admin, o próprio | multipart `photo` |
| `GET /children` | admin, guard | lista com status e responsáveis |
| `POST /children` | admin | cria |
| `GET /children/:id` | admin, guard, responsável vinculado | detalhe + credenciais (admin) + eventos recentes |
| `PATCH /children/:id` | admin | edita / desativa |
| `POST /children/:id/photo` | admin | multipart |
| `PUT /children/:id/guardians/:userId` | admin | cria/atualiza vínculo |
| `DELETE /children/:id/guardians/:userId` | admin | remove vínculo |
| `GET /credentials?ownerType=&ownerId=` | admin | lista |
| `POST /credentials` | admin | `{ownerType, ownerId, kind, value?, label?}` |
| `DELETE /credentials/:id` | admin | revoga |
| `POST /scan/lookup` | guard, admin | `{uid?, code?}` → resultado de identificação |
| `GET /scan/directory` | guard, admin | cache offline: credenciais + pessoas + crianças (sem contatos) |
| `POST /attendance/events` | guard, admin | registra 1..n eventos (mesma ação, várias crianças) |
| `GET /attendance/today` | guard, admin | presentes, contadores, eventos do dia |
| `GET /attendance/events?childId=&from=&to=&limit=&offset=` | guard, admin | histórico |
| `GET /attendance/events.csv?from=&to=` | admin | exportação |
| `GET /reports/daily?date=` | admin | relatório do dia + pendências |
| `GET /me/children` | responsável | filhos com status e responsáveis (nome/parentesco) |
| `GET /me/notifications?limit=&before=` | responsável | feed + `unreadCount` |
| `POST /me/notifications/read` | responsável | `{ids?}` ou tudo |
| `GET/PATCH /me/preferences` | responsável | preferências |
| `POST/DELETE /me/push-subscriptions` | responsável | inscrição push |
| `PATCH /me` | todos | nome, telefone |
| `GET /files/:id` | autenticado com acesso | foto |
| `GET /admin/stats` | admin | painel |
| `GET/PATCH /admin/settings` | admin | nome/telefone da creche |
| `POST /admin/test-email` | admin | envia e-mail de teste ao admin |

## 11. Segurança e LGPD

- HTTPS obrigatório (Web NFC, câmera, push e service worker exigem).
- Senhas com scrypt + sal; tokens de sessão/convite guardados como hash.
- Limite de tentativas de login e de `lookup` (anti-enumeração de códigos).
- Vigilante não acessa contatos; responsável só vê os próprios filhos.
- Fotos servidas apenas para usuários autenticados com vínculo.
- Registro de auditoria: todo evento guarda quem registrou; nada é apagado.
- **LGPD** (Lei 13.709/2018): dados de crianças exigem consentimento
  específico de um dos pais (art. 14). O modelo de termo de consentimento fica
  em `docs/LGPD.md`. Colete o mínimo (nome, turma, foto, contatos dos
  responsáveis). Defina retenção (padrão: eventos por 24 meses, script de
  expurgo) e quem tem acesso (admin). Sem rastreadores ou serviços de
  terceiros além do SMTP e do serviço de push do navegador.
- A etiqueta NFC não é um segredo forte (UID pode ser clonado): a segurança
  vem da conferência visual da foto pela vigilante + lista de autorizados +
  alerta imediato a todos os responsáveis. Documentar isso para a creche.

## 12. Implantação

- `docker compose up` sobe servidor + Caddy (HTTPS automático com domínio).
- Alternativas: VPS barato; computador na creche + Cloudflare Tunnel.
- Variáveis: `APP_URL`, `DATA_DIR`, `TZ`, `SMTP_*`, `MAIL_FROM`,
  `SESSION_TTL_DAYS`. Ver `.env.example` e `docs/IMPLANTACAO.md`.
- Primeira execução: cria o banco, gera chaves VAPID e cria o admin inicial a
  partir de `ADMIN_EMAIL`/`ADMIN_PASSWORD` (ou `npm run seed` com dados de
  exemplo).

## 13. Testes

- Servidor: testes de integração com banco em memória cobrindo login, regras
  R1–R9, R11, idempotência, permissões por papel, exportação CSV; envio de
  e-mail/push simulado (mock).
- Web: `tsc --noEmit` + `vite build`; testes unitários das funções de parse de
  carteirinha (URL/NDEF/UID) e da fila offline.
- Ponta a ponta (Playwright, Chromium): semeia o banco → vigilante digita o
  código → confirma entrada → confirma saída → responsável vê o alerta e o
  e-mail simulado aparece na caixa de saída de teste.

## 14. Fora de escopo (por enquanto)

- Aplicativo nativo (loja); leitura NFC no iPhone (Web NFC não existe no iOS —
  usar QR).
- Reconhecimento facial; biometria.
- Integração com sistemas da prefeitura/secretaria de educação.
- Múltiplas creches no mesmo servidor (uma instância por creche).
