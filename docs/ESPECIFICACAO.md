# Creche Segura — Especificação do sistema (v2)

Controle de entrada e saída de crianças em creches, com carteirinha NFC/QR,
app para a portaria (vigilante), app para os responsáveis e painel para a
administração. Toda a interface é em português do Brasil.

Esta versão incorpora a revisão de segurança, de operação e de contrato feita
sobre a v1. Onde houver conflito, **`shared/src/index.ts` (contrato) e
`server/src/db/schema.sql` (banco) prevalecem** sobre o texto.

## 1. Visão geral

**Problema.** A creche não registra quem deixa nem quem busca cada criança,
nem em que horário. Os responsáveis não têm como saber, na hora, com quem a
criança saiu.

**Solução.** Cada responsável (e/ou cada criança) recebe uma carteirinha com
um código curto impresso, um QR Code e, opcionalmente, uma etiqueta NFC. Na
portaria, a vigilante aproxima a carteirinha do celular (ou lê o QR, digita o
código ou busca pelo nome):

1. **Entrada (chegada):** fica registrado qual responsável deixou a criança,
   com data e hora, e quem registrou.
2. **Saída (busca):** fica registrado quem retirou a criança, com data e hora,
   e **todos os responsáveis da criança** recebem um alerta no app e por
   e-mail informando quem retirou e quando.

**Princípios de projeto.**

- Rápido na portaria: identificar + confirmar em dois toques; tela grande,
  legível ao sol; funciona com o celular travado na tela de leitura.
- Seguro por padrão: quem retira precisa estar na lista de autorizados (ou ter
  uma autorização avulsa registrada); a vigilante confere a foto na tela;
  toda exceção fica registrada e gera alerta destacado para responsáveis e
  direção; nada é apagado, só cancelado com motivo.
- Barato de implantar: um servidor pequeno (VPS ou computador na creche), sem
  loja de aplicativos (PWA), carteirinha de papel plastificada com QR; etiqueta
  NFC (NTAG213) é opcional.
- Funciona sem NFC e sem internet boa: QR pela câmera, código digitado, busca
  por nome; identificação local a partir de um diretório em cache; registros
  entram numa fila e são enviados quando a conexão volta.
- Funciona para famílias sem e-mail: responsável pode ser cadastrado só para
  ser reconhecido na portaria; convite por link (WhatsApp) ou QR no balcão.

## 2. Papéis

| Papel | Quem | O que faz |
| --- | --- | --- |
| `admin` (administração) | direção / secretaria | Cadastra crianças, responsáveis, vigilantes; emite carteirinhas; vê relatórios e auditoria; lança folhas de papel; importa planilha; faz backup. |
| `guard` (vigilante / portaria) | quem fica no portão | Lê carteirinhas, confirma entradas e saídas, cancela registro errado, vê quem está na creche, registra recusa de retirada, cola etiqueta NFC numa carteirinha já emitida. |
| `guardian` (responsável) | pais, mães, avós, tios autorizados | Vê status e histórico dos filhos, recebe alertas (push + e-mail), autoriza alguém a buscar hoje, gerencia preferências e senha. |

Uma conta tem exatamente um papel. Um responsável pode estar vinculado a várias
crianças (irmãos). Uma criança pode ter vários responsáveis. Um responsável
**sem e-mail e sem login** pode existir apenas para ser reconhecido na
portaria (não acessa o app nem recebe alertas).

## 3. Conceitos

- **Criança**: nome, data de nascimento, turma, turno (`manha`, `tarde`,
  `integral`), foto, **aviso de portaria** (`gateAlert`, curto, visível para a
  vigilante em vermelho, ex.: "Não entregar ao pai — chamar a direção") e
  **observações** (`notes`, só administração). Registro de consentimento
  LGPD: quem assinou o termo, parentesco e data.
- **Responsável**: usuário com papel `guardian`; nome, e-mail (opcional),
  telefone, foto (só a administração altera — é a foto que a vigilante
  confere). `hasAccess` = tem senha definida.
- **Vínculo (criança ⇄ responsável)**: parentesco, `canPickup` (pode
  retirar), `isPrimary` (contato principal), `validFrom`/`validUntil`
  (autorização temporária), `blocked` (**bloqueado**: pessoa que não pode
  retirar por decisão judicial/da direção; a vigilante vê "NÃO LIBERAR —
  chame a direção"; a pessoa não recebe alertas nem vê a criança no app;
  `blockedReason` só para admin). Remoção é lógica (`removedAt`).
- **Autorização avulsa de retirada** (`pickup_authorizations`): "hoje a
  vizinha busca". Nome, documento (opcional), relação, telefone, validade
  (`validFrom`..`validUntil`, padrão hoje). Criada pela administração ou por um
  responsável com `canPickup` pelo app. A portaria vê a pessoa na lista da
  criança e registra a saída **sem exceção**; o alerta diz "autorizada por
  Maria (mãe)".
- **Carteirinha (credencial)**: uma linha por carteirinha física, ligada a um
  responsável **ou** a uma criança, com: `code` (8 caracteres do alfabeto
  `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, ex.: `7K3P-2Q9M`, impresso e no QR como
  URL `https://<app>/c/7K3P2Q9M`) e `nfcUid` (opcional, UID da etiqueta).
  Perdida → **revogada** (nunca apagada); revogar cancela código e NFC juntos.
- **Evento de presença**: `checkin` (entrada), `checkout` (saída) ou `denied`
  (tentativa de retirada recusada, sem mudar o status). Guarda: criança,
  responsável (ou nome da pessoa não cadastrada + autorização avulsa),
  vigilante, método (`nfc`, `qr`, `code`, `search`, `manual`, `auto`),
  carteirinha usada, horário, observação, `override` (exceção), `conflict`
  (registro vindo da fila que violou a regra de estado), `queued`, cancelamento
  (`voidedAt`, `voidedBy`, `voidReason`). Nomes de criança, responsável e
  vigilante são copiados no evento (snapshot) para o histórico sobreviver a
  remoções e anonimização.
- **Lote** (`batchId`): uma confirmação da vigilante = um lote com 1..n eventos
  (irmãos). Notificações são por lote ("Ana e Pedro saíram…").
- **Status da criança**: derivado do último evento não cancelado do tipo
  `checkin`/`checkout` (ordem `occurred_at DESC, created_at DESC, id DESC`):
  *na creche* ou *fora*. `stale` = na creche desde um dia civil anterior (saída
  não registrada).
- **Notificação**: registro de envio a um usuário por um canal (`inapp`,
  `push`, `email`), por lote, com `kind` (`checkin`, `checkout`, `denied`,
  `void`, `guardian_added`, `authorization_added`, `credential_revoked`,
  `system`), status e retentativas. Segurada por uma janela de desfazer antes
  do envio.

## 4. Fluxos

### 4.1 Identificação na portaria

O app da portaria é **local-first**: ao abrir (e a cada `visibilitychange`,
após cada sincronização e quando `AppConfig.directoryVersion` mudar) baixa
`GET /api/scan/directory` (ETag/304) e guarda em IndexedDB: carteirinhas
(inclusive revogadas nos últimos 90 dias), responsáveis, crianças com vínculos,
avisos e autorizações avulsas, e as fotos (o service worker pré-carrega
`/api/files/*` em cache).

Ordem de tentativa (todas levam à mesma tela de confirmação):

1. **NFC** — Chrome/Android. Máquina de estados do leitor: `unsupported`
   (sem `NDEFReader` → esconde a área NFC e promove o QR), `off` (`NotReadableError`
   → "Ligue o NFC nas configurações"), `blocked` (`NotAllowedError` → como
   liberar nas permissões do site), `idle` (botão grande "Toque para ativar o
   leitor" — `scan()` exige gesto do usuário), `listening` (indicador
   pulsante), `paused` (documento oculto). Tenta `scan()` ao abrir; se
   rejeitar, cai em `idle`; rechecagem em `visibilitychange`; `abort()` ao sair.
   A leitura entrega `serialNumber` (→ `normalizeUid`) e, se houver, registro
   NDEF de URL/texto (→ `parseCardContent`). `readingerror` → "Carteirinha
   ilegível, tente de novo" + vibração.
2. **QR Code** — `BarcodeDetector` se `getSupportedFormats()` incluir
   `qr_code`; senão `jsQR` sobre o vídeo (640×480, ~120 ms). Câmera só no
   modo QR, fechada após 30 s ociosa. `NotAllowedError` → instruções para
   liberar a câmera.
3. **Código digitado** — campo com `autocapitalize=characters`, formatação
   `XXXX-XXXX` ao vivo, envio automático ao completar 8 caracteres válidos,
   aviso quando digitar `0/O/1/I/L`.
4. **Busca por nome** — lista local (diretório) de responsáveis e crianças,
   filtro por turma, sem acentos/maiúsculas, com "recentes" do aparelho.
   Botão de primeira classe (não excepcional). Eventos desse caminho usam
   `method: "search"`.

Resolução: primeiro no diretório local por `(code)` ou `(nfcUid)` já
normalizados. Se encontrar carteirinha revogada → "Carteirinha cancelada —
avise a direção". Se não encontrar → `POST /api/scan/lookup` (3 s de timeout)
→ 404 `CARD_NOT_FOUND` → "Carteirinha não reconhecida" com atalho para busca.
Se `code` e `uid` apontarem para carteirinhas diferentes → 409
`CREDENTIAL_MISMATCH` → "Carteirinha inconsistente — avise a direção".

Para **SAÍDA** o app sempre tenta `lookup` ao vivo (3 s); se falhar, mostra
faixa "SEM CONEXÃO — dados de HH:MM" e exige um segundo toque "Confirmar mesmo
assim". Se o diretório tiver mais de `OFFLINE_CHECKOUT_MAX_AGE_HOURS` (12 h),
saída offline é recusada ("ligue para a secretaria").

Anti-repetição no app: mesma carteirinha lida de novo em 2 s é ignorada; após
um registro com sucesso, a mesma carteirinha é ignorada por 15 s com aviso "Já
registrado às 07:31"; leitura de outra carteirinha enquanto uma confirmação
está aberta vira um chip "Próximo: Fulano" (não navega).

### 4.2 Carteirinha de responsável (fluxo principal)

Tela de confirmação:

- cabeçalho fixo com o nome da vigilante atual e "Trocar";
- foto grande, nome e parentesco do responsável (sem foto → "SEM FOTO —
  confira o documento" + caixa "documento conferido" obrigatória na saída);
- se houver `gateAlert` em alguma criança → faixa vermelha no topo;
- crianças vinculadas com foto, nome, turma, status ("Na creche desde 07:45" /
  "Fora" / "Sem saída ontem") e checkbox (linha inteira ≥ 56 px; sem checkbox
  quando há uma só criança);
- **regra determinística de pré-seleção**: P = crianças presentes (não
  `stale`), F = fora ou `stale`. F ≠ ∅ e P = ∅ → ENTRADA com todas de F
  marcadas. P ≠ ∅ e F = ∅ → SAÍDA com todas de P marcadas. Misto → nada
  pré-marcado e dois botões nomeando as crianças ("ENTRADA: Pedro" / "SAÍDA:
  Ana"). Trocar a ação recalcula a pré-seleção;
- botão grande com ícone + palavra + posição fixa: ENTRADA (verde, esquerda,
  seta entrando) / SAÍDA (laranja, direita, seta saindo), sempre com os nomes
  e a contagem: "Registrar SAÍDA — Ana e Pedro (2)";
- na saída, criança para a qual o responsável não pode retirar (sem
  `canPickup`, fora da validade) aparece em vermelho "NÃO AUTORIZADO A
  RETIRAR"; vínculo `blocked` → tela vermelha "NÃO LIBERAR — chame a direção
  (telefone)" com botão "Registrar tentativa recusada" (evento `denied`).

### 4.3 Carteirinha de criança

Mostra foto/nome da criança e a lista de pessoas que podem retirar: vínculos
(foto, nome, parentesco, selo "pode retirar"/"não autorizado"/"bloqueado") e
autorizações avulsas válidas hoje ("Ana Souza — vizinha, autorizada por Maria
(mãe)"). A vigilante toca em quem está presente e segue para 4.2 com apenas
essa criança. "Outra pessoa (não cadastrada)" → 4.4.

### 4.4 Exceção — pessoa não autorizada ou não cadastrada

Só na **saída**. Formulário curto: nome completo, caixa "documento conferido"
(número opcional), motivo (mín. 10 caracteres). O evento fica com
`override = true`; todos os responsáveis ativos recebem alerta destacado
"**ATENÇÃO** — retirada por pessoa fora da lista de autorizados" e todos os
admins também. O número do documento nunca vai no texto do alerta (só "documento
conferido pela portaria"); fica visível apenas para admin. Na **entrada** não há
bloqueio: qualquer responsável vinculado ou "outra pessoa" com nome.

O servidor só marca `override` nas crianças em que a regra R2 exigiu (uma mãe
autorizada para um filho e vencida para o outro gera exceção só no segundo).

### 4.5 Fila offline e sincronização

Toda confirmação é gravada **primeiro na fila local** (IndexedDB): `batchId`,
um `clientId` por criança, `occurredAt` do aparelho, corpo completo e
`schemaVersion`. A tela de sucesso aparece na hora com um indicador
"enviando…/enviado". Um único worker drena a fila em ordem, um lote por vez,
timeout de 5 s por requisição, backoff 2 s → 60 s. Gatilhos: abertura do app,
`visibilitychange`, evento `online`, após qualquer requisição com sucesso.

Estados por item: `pending → sending → sent | rejected | needs_login`.
Respostas: 200 → `sent` (itens `rejected` do resultado vão para a lista "Não
aplicados" na tela Hoje, que a vigilante precisa dispensar); 4xx no lote
inteiro → `rejected` (nunca retenta 4xx); 401 → `needs_login` com faixa
"Entre novamente para enviar N registros" (a fila sobrevive ao logout);
5xx/rede → retenta. Logout é recusado enquanto houver itens `pending`
("Enviar agora"). O app envia `POST /api/scan/heartbeat` a cada tentativa de
drenagem; o painel mostra "Portaria: 6 registros pendentes desde 12:40".

O app mantém uma sobreposição de status local (eventos deste aparelho desde
`directory.generatedAt`, enviados ou não) usada para "Na creche desde", ação
sugerida e contador.

### 4.6 Contas e convites

- Administração cria o responsável ao cadastrar a criança (nome, parentesco,
  pode retirar; e-mail e telefone opcionais). Sem e-mail e sem login = "só
  portaria" (`hasAccess = false`, selo "sem contato" no painel).
- **Convite**: token de 32 bytes aleatórios (guardado como SHA-256), válido
  90 dias, reenvio invalida os anteriores. Entrega: e-mail (se configurado),
  link para WhatsApp (`InviteResult.whatsappUrl` = `https://wa.me/55<fone>?text=…`)
  ou QR na tela do admin para o responsável ler no balcão. A página
  `/convite/:token` mostra nome e papel, pede a senha (mín. 8) e já entra.
  Detecta navegador embutido (WhatsApp/Instagram/Facebook) e orienta "abrir no
  navegador"; no iPhone orienta a adicionar à tela inicial antes de ativar
  notificações.
- **Esqueci a senha**: `identifier` (e-mail ou login) → token de 1 h. Sem
  e-mail → a administração gera um link de redefinição (nunca define a senha do
  responsável diretamente). Admin pode definir senha diretamente apenas para
  `admin` e `guard`.
- **Vigilantes**: login curto (`login`, ex.: `carlos`) e PIN de 4–6 dígitos
  para **troca rápida** no celular da portaria (`POST /auth/switch`, só a
  partir de uma sessão de portaria/admin já válida, limite de tentativas por
  sessão). O cabeçalho mostra sempre o nome da vigilante atual. Ao voltar
  após 6 h em segundo plano o app oferece a troca.
- **Sessões**: token opaco (Bearer) de 32 bytes, hash no banco, validade
  deslizante `SESSION_TTL_DAYS` (30) e teto absoluto de 90 dias. Trocar a
  própria senha revoga as outras sessões; senha redefinida por token, senha
  definida por admin, desativação e anonimização revogam **todas** as sessões e
  inscrições push do usuário. Inscrição push pertence à sessão que a criou
  (logout a remove). Qualquer 401 no app limpa token e diretório (a fila fica).

### 4.7 Emissão de carteirinhas

1. **Gerar** — `POST /credentials` (uma) ou `POST /credentials/bulk` (todas as
   crianças/responsáveis de uma turma que ainda não têm).
2. **Imprimir** — página de impressão em lote: cartões CR80 (10 por A4) com
   primeiro nome + inicial do sobrenome, turma (criança), nome e telefone da
   creche, código em texto ≥ 14 pt, QR ≥ 3 cm com margem, espaço para a
   etiqueta NFC; foto só com a opção "com foto". Recomenda-se plastificar
   fosco.
3. **Colar etiqueta NFC** (opcional, Chrome/Android; admin ou vigilante):
   lê o QR/código da carteirinha e encosta a etiqueta → `POST /credentials/:id/nfc`
   grava o UID; opcionalmente grava a URL do código na etiqueta (`write()` +
   `makeReadOnly()`).
4. **Revogar e gerar nova** — uma ação.

### 4.8 Cancelar registro (desfazer)

Toda confirmação tem uma janela de `NOTIFY_HOLD_SECONDS` (45 s) antes de
qualquer envio. A tela de sucesso mostra "Desfazer" com contagem regressiva e,
ao voltar para Leitura, um chip "Desfazer último registro (0:32)". Desfazer
chama `POST /attendance/events/:id/void`; dentro da janela nada é enviado;
fora dela, a vigilante (até 24 h) ou a administração (sempre) pode cancelar
com motivo e os responsáveis recebem "Registro cancelado" (nunca um alerta de
saída falso). Eventos cancelados não contam para o status.

### 4.9 Folha de papel e lançamento posterior

`/portaria/folha` imprime a folha de presença do dia por turma (nome · entrada
__:__ · quem deixou · saída __:__ · quem retirou · assinatura), gerada do
diretório. Depois, a administração digita a folha em "Lançar folha"
(`POST /attendance/backfill`, uma linha por evento, `method: "manual"`,
`occurredAt` explícito). Notificações de lançamentos com mais de 3 h de atraso
vão só por `inapp` + e-mail, com o texto "registro lançado às 20:05 pela
secretaria".

### 4.10 Importação de planilha

`POST /admin/import?dryRun=true` recebe CSV (`;`, UTF-8 com BOM; modelo em
`GET /admin/import/template.csv`) com uma linha por par criança–responsável:
`crianca;nascimento;turma;turno;resp_nome;resp_parentesco;resp_email;resp_telefone;pode_retirar;principal`.
Resposta por linha: `create_child | link_existing | create_guardian | skip` +
erros. Criança casa por (nome, nascimento); responsável por e-mail, senão por
(nome, telefone). Importar não envia convites ("Enviar convites pendentes" é
um botão separado).

## 5. Regras de negócio

- **R1 (estado).** `checkin` só com a criança *fora* — ou *na creche* desde
  um dia civil anterior (`stale`): nesse caso o servidor grava antes, na mesma
  transação, um `checkout` automático (`method: "auto"`, `note: "Fechamento
  automático: saída não registrada em DD/MM"`, `occurred_at` = 23:59:59 do dia
  da entrada no fuso da creche, notificação só `inapp`). `checkout` só com a
  criança *na creche*; se `stale`, exige `note` (senão `STALE_PRESENCE`).
  Evento ao vivo em conflito → item `rejected` com `INVALID_STATE` e
  `currentStatus`. Evento **da fila** (`queued: true`) em conflito → gravado
  com `conflict = "already_present" | "already_out"`, notificado normalmente e
  destacado no painel (o registro verdadeiro de quem levou a criança nunca se
  perde).
- **R2 (quem pode retirar).** `checkout` permitido sem exceção quando o
  responsável tem vínculo ativo, não bloqueado, com `canPickup` e dentro de
  `validFrom..validUntil` (dia civil no fuso da creche), **ou** quando
  `authorizationId` aponta para uma autorização avulsa da criança válida hoje
  **e o evento é da própria pessoa autorizada** (`personName`, sem
  `guardianId`) — uma autorização avulsa nunca amplia o que um responsável
  cadastrado pode fazer. Caso contrário exige `override: true` + `note` (≥ 10)
  e, para pessoa não cadastrada, `personName`. Vínculo `blocked` → recusa mesmo
  com override (`GUARDIAN_BLOCKED`).
- **R3 (entrada).** `checkin` aceita qualquer responsável vinculado (inclusive
  bloqueado — sem risco de retirada) ou `personName`; nunca bloqueia.
- **R4 (idempotência).** Chave = `clientId` (um por criança, UUID gerado pelo
  app na confirmação e reutilizado em cada retentativa). Reenvio devolve o
  evento gravado com `status: "duplicate"`, sem notificar.
- **R5 (toque duplo).** Evento do mesmo `type` para a mesma criança, mesmo
  responsável/pessoa e mesma vigilante com |Δ occurred_at| < 60 s → devolve o
  existente como `duplicate`.
- **R6 (horário).** Evento ao vivo (`queued: false`) usa **sempre** o relógio
  do servidor (o `occurredAt` do aparelho é ignorado — relógios errados são
  comuns). Evento da fila: usa `occurredAt` do aparelho se estiver em
  `[agora − 7 d, agora + 2 min]`; fora disso usa `agora` e adiciona `warning`.
  Lançamento posterior (admin): qualquer `occurredAt` ≤ agora.
- **R7 (correção).** Nada é apagado. Erro = cancelar (`void`, com motivo) e/ou
  lançar de novo. Só admin lança com `occurredAt` arbitrário (backfill).
- **R8 (alerta de saída).** Toda saída (inclusive `override` e `conflict`)
  notifica **todos** os responsáveis com vínculo ativo (não removido, não
  bloqueado, `users.active`), inclusive quem retirou: `inapp` sempre; `push`
  se houver inscrição; `email` sempre que houver e-mail. Exceção, `conflict`,
  `denied` e carteirinha revogada notificam também todos os admins.
- **R9 (alerta de entrada).** `inapp` sempre; `push` e `email` conforme
  preferência (`notifyCheckinPush` padrão ligado; `notifyCheckinEmail` padrão
  desligado).
- **R10 (visibilidade).** Vigilante: nomes, fotos, parentesco, autorização,
  bloqueio, `gateAlert`, status, autorizações avulsas — sem e-mail/telefone,
  sem `notes`, histórico só dos últimos 7 dias. Admin: tudo. Responsável: só os
  próprios filhos; dos outros responsáveis vê nome, parentesco e se pode
  retirar (sem foto nem contato); não vê `notes` nem `gateAlert`. Cada rota
  monta o DTO do seu papel explicitamente.
- **R11 (carteirinha revogada / pessoa inativa).** `lookup` responde 404
  `CARD_REVOKED` / `OWNER_INACTIVE`. Evento **ao vivo** com carteirinha
  revogada → `rejected` (`CARD_REVOKED`). Evento **da fila** com carteirinha
  revogada antes de `occurredAt` → gravado com `override = 1` e `note`
  acrescida de "carteirinha revogada em DD/MM HH:MM", alerta destacado.
- **R12 (pendências).** `presentCount` exclui `stale`; `stalePresentCount`
  separado. Criança `stale` aparece na Leitura como "fora" com selo "Sem saída
  ontem"; para o responsável, "Saída de ontem não registrada pela creche —
  fale com a secretaria" (nunca "Na creche desde ontem").
- **R13 (autenticação).** Senha ≥ 8 (admin ≥ 12); scrypt. Login: 5 falhas /
  15 min por identificador **e** 20 / 15 min por IP (`TRUST_PROXY`), `429` com
  `retryAfterSeconds`; sessões válidas nunca são bloqueadas. `lookup` e
  `manual`: só **falhas** contam (20 por 10 min por sessão). Eventos e
  heartbeat nunca são limitados. Servidor recusa iniciar com
  `ADMIN_PASSWORD` igual ao exemplo ou < 12 caracteres.
- **R14 (tempo).** Instantes (`occurredAt`, `createdAt`, `since`, `revokedAt`,
  `readAt`, `generatedAt`, `expiresAt`, `undoUntil`, …) = ISO 8601 UTC com
  milissegundos e `Z` (`Date.prototype.toISOString()`); o servidor normaliza
  qualquer offset recebido antes de guardar. Datas civis (`birthDate`,
  `validFrom`, `validUntil`, `date`, `from`, `to`, `month`) = `YYYY-MM-DD` no
  fuso `TZ`. "Hoje" = dia civil no fuso da creche (`civilDate(now, tz)` do
  pacote shared) — nunca `toISOString().slice(0,10)`. Intervalos `from..to`
  inclusivos = `[from 00:00 TZ, to+1 00:00 TZ)`.
- **R15 (consistência do método).** `method` ∈ {`nfc`,`qr`,`code`} exige
  `credentialId` ativo pertencente ao responsável ou a uma das crianças do
  lote; `search`/`manual`/`auto` exigem `credentialId` nulo.
- **R16 (mudanças na lista de autorizados).** Criar/reativar/estender um
  vínculo com `canPickup` ou criar autorização avulsa notifica os outros
  responsáveis ativos da criança (`guardian_added` / `authorization_added`).
  Revogar carteirinha notifica o dono (`credential_revoked`).
- **R17 (desativação).** Desativar criança presente grava `checkout`
  automático (`auto`, sem notificações). Diretório, `present`, `absent` e
  pendências filtram `active = 1`. `/me/children` devolve inativas com
  `active: false`.
- **R18 (auditoria).** Toda mutação administrativa (usuários, vínculos,
  autorizações, carteirinhas, fotos, senhas, configurações, cancelamentos,
  anonimização, importação) gera linha em `audit_log` (ator, ação, entidade,
  detalhes, IP).

### Algoritmo de `POST /attendance/events` (uma transação por lote)

1. Validar corpo; resolver responsável/pessoa/autorização; R15.
2. Determinar `occurred_at` (R6); `batch_id` = novo UUID (ou o do primeiro
   item existente).
3. Para cada item, em ordem: R4 → R5 → vínculo bloqueado (só `checkout`/`denied`
   permitidos como recusa) → R1 (com fechamento automático) → R2 → inserir com
   snapshots (`child_name`, `guardian_name`, `guardian_relationship`,
   `guard_name`). Itens `rejected` não interrompem os demais.
4. Se algum item foi `created`: criar notificações `pending` por
   destinatário/canal com `dispatch_after = now + NOTIFY_HOLD_SECONDS`.
5. Responder `200 CreateEventsResult` com `undoUntil`.

### Despacho de notificações (worker a cada 5 s)

Seleciona `pending` com `dispatch_after ≤ now` e `attempts < 3`. `inapp`:
marca `sent` (o feed só mostra `sent`). `push`: `web-push`; 404/410 apagam a
inscrição. `email`: nodemailer; erro transitório (4xx SMTP) → `attempts++`,
`dispatch_after = now + 60 s / 300 s / 1800 s`; permanente → `failed`. Limite
diário `SMTP_DAILY_LIMIT` (450): ao atingir, e-mails de rotina viram `skipped`
(`quota`), exceções continuam, admins são avisados uma vez. Cancelamento dentro
da janela → todas as linhas `pending` do lote viram `skipped` (`voided`).

## 6. Notificações — conteúdo

Assunto de e-mail sempre com prefixo `[<nome da creche>]`; `From` =
`MAIL_FROM`; `Reply-To` = `contactEmail` das configurações; partes texto e
HTML. Datas no fuso da creche (`formatDateTime` do shared).

- **Saída**: título "Saída registrada — Ana e Pedro"; corpo "Ana e Pedro
  saíram da creche às 17:32 (10/09/2026) com **Maria Silva (mãe)**. Entrada
  hoje às 07:45. Registrado por Carlos (portaria)."
- **Saída com autorização avulsa**: "… com **Ana Souza (vizinha)**, autorizada
  por Maria Silva (mãe)."
- **Exceção**: título "ATENÇÃO — retirada fora da lista de autorizados"; corpo
  "João saiu às 17:32 com **Ana Souza (não cadastrada)**, documento conferido
  pela portaria. Motivo: 'mãe ligou autorizando'. Registrado por Carlos. Se
  você não reconhece esta retirada, ligue agora para a creche: (xx) xxxx-xxxx."
- **Entrada**: "Entrada — João, 07:45"; "João chegou à creche às 07:45
  (10/09/2026), deixado por Maria (mãe). Registrado por Carlos."
- **Recusa**: "Tentativa de retirada recusada — João"; "Carlos (pai,
  bloqueado) tentou retirar João às 16:50. A portaria não liberou."
- **Cancelamento**: "Registro cancelado — João"; "O registro de saída de João
  às 17:32 foi cancelado por Carlos (motivo: toque errado)."
- **Nova pessoa autorizada**: "Nova pessoa autorizada a retirar João: Ana
  (tia), até 15/09."
- **Autorização avulsa**: "Maria (mãe) autorizou Ana Souza (vizinha) a retirar
  João hoje."
- **Carteirinha revogada**: "A carteirinha 7K3P-2Q9M foi cancelada pela
  creche."
- Push: `tag = "batch:<batchId>"` (colapsa irmãos), corpo com até 3 nomes e
  "+N"; `url = /alertas?n=<notificationId>`.

## 7. Telas e rotas do app

Rotas web: `/login`, `/convite/:token`, `/redefinir/:token`, `/esqueci`,
`/c/:code` (público: "Carteirinha da <creche>. Se encontrou, ligue (xx)";
com sessão de portaria aberta em outra aba, envia o código pelo
`BroadcastChannel` e fecha), `/portaria` (Leitura), `/portaria/confirmar`,
`/portaria/hoje`, `/portaria/historico`, `/portaria/folha`, `/portaria/trocar`,
`/inicio`, `/alertas`, `/filho/:id`, `/config`, `/admin`, `/admin/criancas`,
`/admin/criancas/:id`, `/admin/responsaveis`, `/admin/responsaveis/:id`,
`/admin/equipe`, `/admin/carteirinhas`, `/admin/carteirinhas/imprimir`,
`/admin/alertas` (exceções, conflitos, recusas e avisos do sistema para a
direção), `/admin/relatorios`, `/admin/lancar`, `/admin/importar`, `/admin/auditoria`,
`/admin/configuracoes`. O servidor devolve `index.html` para tudo que não é
`/api/*`, `/sw.js`, `/manifest.webmanifest`, `/assets/*`.

### Portaria (vigilante)

1. **Leitura** — cabeçalho com vigilante atual + "Trocar"; área NFC conforme
   estado (oculta se o diretório não tem nenhum `nfcUid`); botões "Ler QR
   Code", "Digitar código", "Buscar por nome"; contador "N na creche (+M sem
   saída ontem)"; chip da fila ("3 aguardando envio", vermelho após 10 min);
   chip "Desfazer último registro (0:32)"; lembra o último modo usado.
   `wakeLock` de tela ativo aqui e na confirmação.
2. **Confirmação** — 4.2/4.3/4.4. Vibração `[60]` na leitura.
3. **Sucesso** — tela cheia verde/laranja com nomes e horário, "Desfazer" com
   contagem, some ao tocar ou em 3 s; nova leitura durante a tela vai direto
   para a próxima confirmação. Vibração `[80,40,80]` entrada, `[200]` saída,
   `[400,100,400]` erro.
4. **Hoje** — presentes por turma/turno (foto, nome, hora de entrada, quem
   deixou), busca, seção "Sem saída registrada ontem", lista "Não aplicados"
   da fila, ação "Registrar saída" manual (escolhe pessoa da lista) e "Cancelar
   registro".
5. **Histórico** — eventos dos últimos 7 dias com filtros; cancelar registro
   (até 24 h).
6. **Folha** — impressão da folha de presença por turma.
7. **Trocar vigilante** — lista de vigilantes ativos → PIN.

### Responsável

1. **Início** — card por filho: "Na creche desde 07:45 · deixado por Maria
   (mãe)" / "Fora da creche · saiu 17:30 com João (pai)" / "Saída de ontem não
   registrada — fale com a secretaria" / "Desligado(a) em DD/MM"; badge de
   alertas; botão "Autorizar alguém a buscar hoje".
2. **Alertas** — feed (só `inapp` enviados), mais recente primeiro, exceções em
   destaque, marca como lido ao abrir.
3. **Filho** — histórico (`GET /attendance/events?childId=`), pessoas
   autorizadas (nome, parentesco, pode retirar) e autorizações avulsas (criar /
   revogar as próprias).
4. **Configurações** — ativar notificações (pede permissão, inscreve, "Enviar
   teste"), preferências de entrada, trocar senha, sair. Sem foto (só a creche
   altera).

### Administração

1. **Painel** — na creche agora (+ sem saída), entradas/saídas hoje, exceções e
   conflitos recentes, crianças sem responsável alcançável, sem consentimento,
   faltando há 5+ dias, e-mail/push (falhas 24 h, e-mails hoje), portaria
   (fila pendente), último backup (vermelho > 48 h), banner "DADOS DE
   DEMONSTRAÇÃO" quando aplicável.
2. **Crianças** — lista com busca/turma/turno; cadastro (nome, nascimento,
   turma, turno, aviso de portaria, observações, consentimento LGPD); foto;
   responsáveis (adicionar existente ou novo com parentesco/pode
   retirar/principal/validade; bloquear com motivo; remover); autorizações
   avulsas; carteirinhas (gerar, imprimir, colar NFC, revogar); histórico;
   desativar; anonimizar; imprimir lista de autorizados.
3. **Responsáveis** — lista (selos "sem contato", "sem acesso", última falha de
   e-mail); cadastro; foto; convite (e-mail / WhatsApp / QR); link de
   redefinição; filhos; carteirinhas; encerrar sessões; anonimizar.
4. **Equipe** — vigilantes e administradores (login, PIN, senha, desativar).
5. **Carteirinhas** — todas as credenciais; gerar em lote por turma; imprimir em
   lote; revogar.
6. **Relatórios** — dia (entrada, saída, quem, pendências, exceções), frequência
   mensal por criança/turma (dias letivos = dias com ≥ 1 entrada na unidade),
   exportar CSV.
7. **Lançar folha** — grade da turma/data com pessoas autorizadas e horários.
8. **Importar** — CSV com pré-visualização (`dryRun`).
9. **Auditoria** — log.
10. **Configurações** — nome, telefone, e-mail de contato da creche; teste de
    e-mail; estado do push; backup (baixar / executar agora).

## 8. Arquitetura, stack e regras de UI

- Monorepo npm workspaces: `shared/` (contrato), `server/`, `web/`. Node 22,
  TypeScript, ESM. Todos os `id` são UUID v4 (`crypto.randomUUID()`).
- **Servidor**: Fastify 5 (`trustProxy` via env); SQLite (better-sqlite3, WAL)
  em `DATA_DIR/creche.sqlite`; fotos em `DATA_DIR/uploads/<fileId>.<ext>`;
  backups em `DATA_DIR/backups/`; nodemailer; web-push (chaves VAPID e
  `files_secret` gerados na primeira execução e guardados em `settings`; env
  só semeia `settings` na primeira execução — depois `settings` vence). Serve
  `web/dist` (`WEB_DIST`) com fallback SPA. Cache: `index.html`, `sw.js`,
  `manifest.webmanifest` → `no-cache`; `/assets/*` → `immutable`.
- **Fotos**: `photoUrl = "/api/files/<fileId>?t=<sig>"`,
  `sig = base64url(HMAC-SHA256(files_secret, fileId)).slice(0, 32)`; a rota
  valida `t` em tempo constante, sem sessão; `Cache-Control: private,
  max-age=86400`, `ETag`, `X-Content-Type-Options: nosniff`,
  `Content-Disposition: inline`, `Content-Security-Policy: sandbox`. Upload:
  multipart campo `photo`, ≤ 2 MiB, JPEG/PNG/WebP verificados pelos bytes
  iniciais (nunca SVG); o navegador redimensiona para ≤ 512 px JPEG antes de
  enviar (isso também remove EXIF). Trocar a foto apaga o arquivo anterior.
- **Web**: Vite + React 19 + TypeScript, react-router 7, CSS próprio em `rem`
  (testar com texto do sistema em 200 %), `<html lang="pt-BR">`, viewport sem
  `maximum-scale`, alvos de toque ≥ 48 px, `aria-live` para estado do leitor e
  ação sugerida, `prefers-reduced-motion`. Datas sempre via
  `formatDateTime(iso, config.timezone)` do shared. Service worker próprio em
  `/sw.js` (escopo `/`): `skipWaiting` + `clients.claim`; pré-cache dos assets
  com hash; `index.html` network-first; `/api/files/*` cache-first (máx. 600
  entradas); `/api/scan/directory` network-first com fallback; nunca cacheia
  outros `/api/*`; push → `showNotification`; clique → abre `payload.url`.
  Atualização: `registration.update()` em `visibilitychange`, após
  `GET /config` e a cada 30 min; `AppConfig.appVersion` diferente → faixa "Nova
  versão — toque para atualizar"; recarrega sozinho só ocioso na Leitura, sem
  confirmação aberta, sem janela de desfazer e com fila vazia. Itens da fila
  levam `schemaVersion`.
- **Autenticação**: `Authorization: Bearer <token>`; token em `localStorage`.
- **CSP** da PWA sem scripts inline.

## 9. Modelo de dados

Ver `server/src/db/schema.sql` (fonte da verdade). Tabelas: `settings`,
`files`, `users`, `children`, `child_guardians`, `pickup_authorizations`,
`credentials`, `attendance_events`, `notifications`, `push_subscriptions`,
`sessions`, `auth_tokens`, `login_attempts`, `audit_log`, `gate_heartbeats`.

## 10. API

Contrato completo em `shared/src/index.ts` (DTOs, schemas zod, `ERROR_CODES`
e mapa HTTP). Rotas sob `/api`, JSON, `Authorization: Bearer <token>` exceto as
públicas. Erros: `{ error: { code, message, details? } }`.

Mapa HTTP: `VALIDATION`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `OCCURRED_AT_INVALID`,
`WEAK_PASSWORD` → 400; `UNAUTHORIZED`, `INVALID_CREDENTIALS`, `INVALID_PIN` → 401;
`FORBIDDEN`, `PICKUP_NOT_ALLOWED`, `GUARDIAN_BLOCKED` → 403; `NOT_FOUND`,
`CARD_NOT_FOUND`, `CARD_REVOKED`, `OWNER_INACTIVE` → 404; `INVALID_STATE`,
`STALE_PRESENCE`, `EMAIL_IN_USE`, `LOGIN_IN_USE`, `CREDENTIAL_MISMATCH`,
`CODE_IN_USE`, `UID_IN_USE`, `QUEUE_PENDING` → 409; `FILE_TOO_LARGE` → 413;
`UNSUPPORTED_MEDIA` → 415; `RATE_LIMITED` → 429 (`details.retryAfterSeconds`);
`EMAIL_DISABLED`, `INTERNAL` → 500/503.

| Método e rota | Papel | Descrição / resposta |
| --- | --- | --- |
| `GET /config` | público | `AppConfig` |
| `POST /auth/login` | público | `LoginBody` → `AuthResult` |
| `POST /auth/accept-invite` | público | → `AuthResult` |
| `GET /auth/invite/:token` | público | `{ name, role, expiresAt }` |
| `POST /auth/forgot-password` | público | `{ identifier }` → 204 sempre |
| `GET /auth/reset/:token` | público | `{ name }` |
| `POST /auth/reset-password` | público | → `AuthResult` |
| `GET /public/cards/:code` | público | `{ daycareName, daycarePhone }` (sempre 200, mesmo corpo) |
| `POST /auth/logout` | todos | 204; remove a sessão e sua inscrição push |
| `GET /auth/me` | todos | `{ user: UserDTO }` |
| `POST /auth/change-password` | todos | 204; revoga as outras sessões |
| `PATCH /me` | todos | `UpdateMeBody` → `UserDTO` |
| `GET /files/:id?t=` | assinado | foto |
| `GET /auth/guards` | guard, admin | `{ id, name, photoUrl }[]` vigilantes ativos |
| `POST /auth/switch` | guard, admin | `{ userId, pin }` → `AuthResult` (nova sessão; a atual é encerrada) |
| `GET /scan/directory` | guard, admin | `ScanDirectory` (ETag) |
| `POST /scan/lookup` | guard, admin | `ScanLookupBody` → `ScanLookupResult` |
| `POST /scan/manual` | guard, admin | `ManualLookupBody` → `ScanLookupResult` (`matchedBy: "search"`) |
| `POST /scan/heartbeat` | guard, admin | `HeartbeatBody` → 204 |
| `POST /attendance/events` | guard, admin | `CreateEventsBody` → `CreateEventsResult` |
| `POST /attendance/events/:id/void` | guard (≤ 24 h), admin | `VoidEventBody` → `AttendanceEventDTO` |
| `POST /attendance/backfill` | admin | `BackfillBody` → `CreateEventsResult` (linhas podem trazer `authorizationId` — saída por autorização avulsa, sem exceção — e `override` + `note` ≥ 10 para lançar uma exceção) |
| `GET /attendance/today` | guard, admin | `TodaySummary` |
| `GET /attendance/events` | guard (≤ 7 dias), admin, guardian (`childId` próprio obrigatório) | `EventsQuery` → `EventsPage` |
| `GET /attendance/events.csv` | admin | CSV (ver abaixo) |
| `GET /children` | guard, admin | `ChildGateDTO[]` (admin recebe `ChildAdminDTO[]`); `?q=&className=&includeInactive=` |
| `POST /children` | admin | `CreateChildBody` → `ChildAdminDTO` |
| `GET /children/:id` | admin, guard, guardian vinculado | `ChildAdminDTO` / `ChildGateDTO` / `MyChildDTO` |
| `PATCH /children/:id` | admin | `UpdateChildBody` → `ChildAdminDTO` |
| `POST /children/:id/photo` | admin | multipart `photo` → `{ photoUrl }` |
| `POST /children/:id/guardians` | admin | `CreateGuardianForChildBody` → `{ child, guardian, invite }` (409 `EMAIL_IN_USE`) |
| `PUT /children/:id/guardians/:userId` | admin | `ChildGuardianBody` → `ChildAdminDTO` |
| `DELETE /children/:id/guardians/:userId` | admin | → `ChildAdminDTO` (remoção lógica) |
| `GET /children/:id/pickup-authorizations` | admin, guardian vinculado | `PickupAuthorizationDTO[]` (`?includeExpired=`) |
| `POST /children/:id/pickup-authorizations` | admin, guardian com `canPickup` | `PickupAuthorizationBody` → `PickupAuthorizationDTO` |
| `DELETE /children/:id/pickup-authorizations/:authId` | admin, guardian que criou | 204 (revoga) |
| `POST /children/:id/anonymize` | admin | `AnonymizeBody` → 204 (só inativa) |
| `GET /users?role=&q=&includeInactive=` | admin | `UserDTO[]` |
| `POST /users` | admin | `CreateUserBody` → `{ user, invite }` |
| `GET /users/:id` | admin | `UserDetailDTO` |
| `PATCH /users/:id` | admin | `UpdateUserBody` → `UserDTO` |
| `POST /users/:id/invite` | admin | → `InviteResult` (convite ou link de redefinição para quem já tem senha) |
| `POST /users/:id/photo` | admin | multipart → `{ photoUrl }` |
| `POST /users/:id/pin` | admin | `{ pin }` → 204 (guard) |
| `POST /users/:id/sessions/revoke` | admin | 204 |
| `POST /users/:id/anonymize` | admin | `AnonymizeBody` → 204 (só inativo) |
| `GET /credentials?ownerType=&ownerId=&className=&includeRevoked=` | admin | `CredentialDTO[]` |
| `POST /credentials` | admin | `CreateCredentialBody` → `CredentialDTO` (código gerado) |
| `POST /credentials/bulk` | admin | `BulkCredentialsBody` → `{ created: CredentialDTO[] }` |
| `POST /credentials/:id/nfc` | admin, guard | `{ uid }` → `CredentialDTO` (409 `UID_IN_USE`) |
| `DELETE /credentials/:id` | admin | → `CredentialDTO` (revogada) |
| `GET /reports/daily?date=` | admin | `DailyReport` |
| `GET /reports/frequency?month=&className=` | admin | `FrequencyReport` (`.csv` com `?format=csv`) |
| `GET /admin/stats` | admin | `AdminStats` |
| `GET/PATCH /admin/settings` | admin | `DaycareSettings` |
| `POST /admin/test-email` | admin | 204 / 503 `EMAIL_DISABLED` |
| `GET /admin/audit?limit=&before=` | admin | `AuditPage` |
| `GET /admin/notifications?status=&limit=` | admin | `AdminNotificationRow[]` |
| `GET /admin/gate-status` | admin | `GateStatus[]` |
| `POST /admin/backup` | admin | → `{ lastBackupAt }` |
| `GET /admin/backup` | admin | `application/gzip` (tar com sqlite + uploads) |
| `POST /admin/import?dryRun=` | admin | multipart `file` (CSV) → `ImportResult` |
| `GET /admin/import/template.csv` | admin | modelo |
| `GET /me/children` | guardian | `MyChildDTO[]` |
| `GET /me/notifications?limit=&before=` | guardian | `NotificationsPage` (só `inapp` enviadas) |
| `POST /me/notifications/read` | guardian | `{ ids? }` → `{ unreadCount }` |
| `GET/PATCH /me/preferences` | guardian | `Preferences` |
| `POST /me/push-subscriptions` | guardian, admin | `PushSubscriptionBody` → 201 `{ id }` (upsert por endpoint) |
| `POST /me/push-subscriptions/unsubscribe` | guardian, admin | `{ endpoint }` → 204 |
| `POST /me/push-subscriptions/test` | guardian, admin | 204 |

**CSV de eventos**: `text/csv; charset=utf-8`, BOM, `;`, CRLF, RFC 4180,
`occurred_at ASC`, `from`/`to` padrão hoje, máx. 366 dias. Cabeçalho:
`data;hora;tipo;crianca;turma;responsavel;parentesco;pessoa_nao_cadastrada;documento;autorizacao;metodo;excecao;conflito;cancelado;observacao;registrado_por;id_evento`
(`data` = DD/MM/AAAA, `hora` = HH:MM:SS no fuso, `tipo` ∈ entrada|saida|recusa,
`excecao`/`conflito`/`cancelado` ∈ sim|nao, `metodo` = rótulo).

## 11. Segurança e LGPD

- HTTPS obrigatório. Senhas scrypt; tokens de sessão/convite como SHA-256,
  comparação em tempo constante. Limites conforme R13.
- Vigilante não acessa contatos nem observações; responsável só vê os próprios
  filhos; fotos só por URL assinada; uploads verificados por bytes.
- Auditoria (R18) e snapshots nos eventos; nada é apagado — anonimização
  (`POST …/anonymize`) substitui nome por "Responsável removido #NNNN" /
  "Criança removida #NNNN", apaga contatos, nascimento, observações e fotos,
  revoga carteirinhas e sessões, e mantém os eventos.
- **LGPD**: consentimento registrado por criança (quem, parentesco — só
  `mae`/`pai`/`responsavel_legal` —, data); painel lista crianças sem
  consentimento; documento de terceiros nunca em alertas; retenção padrão 24
  meses (script `npm run purge`: anonimiza crianças inativas há mais de
  `RETENTION_MONTHS`, apaga `login_attempts` > 24 h e `person_document` > 12
  meses). Ver `docs/LGPD.md`.
- A etiqueta NFC não é segredo forte: a segurança vem da foto conferida pela
  vigilante + lista de autorizados + alerta a todos os responsáveis + registro
  de recusas e exceções.

## 12. Implantação e operação

- `docker compose up -d` sobe servidor + Caddy; `./data` é bind-mount (fica
  ao lado do compose). Alternativas: VPS barato; computador na creche +
  Cloudflare Tunnel.
- E-mail via provedor autenticado (Gmail + senha de app 500/dia, Brevo
  300/dia, Amazon SES); `MAIL_FROM` deve ser a caixa autenticada; `requireTLS`
  quando `SMTP_SECURE=false`. Ver `docs/IMPLANTACAO.md`.
- Backup automático diário 02:00 (`db.backup()` + tar de `uploads/`), rotação
  `BACKUP_KEEP_DAYS` (14); botão "Baixar backup"; `npm run restore <arquivo>`.
- Primeira execução: cria o banco, gera chaves, cria o admin de
  `ADMIN_EMAIL`/`ADMIN_PASSWORD` (recusa a senha do exemplo).
- **Dados de demonstração** (`node server/dist/seed.js` ou `npm run seed`):
  determinísticos — admin `admin@demo.local` / `demo-admin-123`, vigilantes
  `carlos` (PIN `1234`, senha `demo-guard-123`) e `ana` (PIN `5678`), 3 turmas,
  12 crianças (2 pares de irmãos, 1 `stale` desde ontem, 1 sem foto, 1 vínculo
  vencido, 1 `canPickup = false`, 1 bloqueado), 20 responsáveis (alguns sem
  senha/sem e-mail; `maria@demo.local` / `demo-maria-123` com dois filhos),
  carteirinhas com códigos fixos (ex.: `AAAA-2222` = Maria), 5 dias de eventos.
  Recusa rodar num banco com dados reais sem `--force`; grava
  `settings.demo_data = 1` (banner). `--clean` remove só os dados de demo.
- Celular da portaria: NFC ligado, carregador, bloqueio automático no máximo,
  app instalado na tela inicial.

## 13. Testes

- **Servidor** (`node:test`, banco em memória, e-mail/push simulados): login e
  limites; convite/redefinição; troca por PIN; regras R1–R17 (inclusive lote
  com irmãos, duplicata, toque duplo, fila com conflito, carteirinha revogada,
  bloqueado, autorização avulsa, fechamento automático, cancelamento dentro e
  fora da janela); projeções por papel; despacho de notificações (hold,
  retentativa, quota); CSV; importação `dryRun`; anonimização; backup.
- **Shared**: parse de carteirinha, datas civis, `pickupAllowed`.
- **Web**: `tsc` + `vite build`; testes das funções puras (pré-seleção,
  fila, parse).
- **Ponta a ponta** (Playwright/Chromium, `npm run test:e2e`): sobe servidor
  com seed → login da vigilante → digita `AAAA-2222` → confirma ENTRADA dos
  dois filhos → desfaz → confirma de novo → confirma SAÍDA → login de Maria →
  vê os dois alertas (após a janela) → e-mail simulado gravado no `outbox` de
  teste → admin vê o evento no relatório do dia.

## 14. Fora de escopo (por enquanto)

- App nativo; NFC no iPhone (usar QR); reconhecimento facial.
- Foto de evidência na exceção; confirmação de recebimento do push; Background
  Sync API; SMS/WhatsApp oficial; lista de feriados; múltiplas creches por
  servidor; integração com sistemas da secretaria de educação.
