# Implantação — passo a passo

Este guia é para quem vai colocar o Creche Segura no ar e mantê-lo funcionando:
a direção da creche (com ajuda de alguém que saiba usar um terminal) ou a
pessoa de TI da prefeitura. Não é preciso ser programador; é preciso seguir os
passos na ordem.

Índice:

1. [Onde hospedar](#1-onde-hospedar)
2. [Domínio e HTTPS](#2-domínio-e-https)
3. [Instalação com Docker Compose](#3-instalação-com-docker-compose)
4. [Variáveis de ambiente, uma a uma](#4-variáveis-de-ambiente-uma-a-uma)
5. [E-mail](#5-e-mail)
6. [Notificações push](#6-notificações-push)
7. [Primeira execução e administrador inicial](#7-primeira-execução-e-administrador-inicial)
8. [Backup e restauração](#8-backup-e-restauração)
9. [Atualização de versão](#9-atualização-de-versão)
10. [Retenção de dados (`npm run purge`)](#10-retenção-de-dados-npm-run-purge)
11. [Instalação sem Docker](#11-instalação-sem-docker)
12. [Solução de problemas](#12-solução-de-problemas)

## 1. Onde hospedar

O sistema é leve: um processo Node.js, um banco SQLite e uma pasta de fotos.
Uma creche com 200 crianças gera poucos megabytes por ano.

| Opção | Custo aproximado | Vantagens | Cuidados |
| --- | --- | --- | --- |
| **VPS barato** (1 vCPU, 1 GB RAM, 20 GB disco, Ubuntu 24.04) em provedores como Hetzner, DigitalOcean, Contabo, Oracle Cloud (camada gratuita) ou provedores nacionais | R$ 20–40/mês | Fica no ar 24 h; IP fixo; HTTPS automático com Caddy; não depende da internet da creche | Alguém precisa aplicar atualizações do sistema operacional; guarde os backups fora do VPS |
| **Computador na creche + Cloudflare Tunnel** | só a energia e a internet que já existem | Sem custo mensal; os dados ficam fisicamente na creche | O computador precisa ficar ligado no horário de funcionamento (e às 02:00 para o backup automático, ou ajuste o horário); se a internet da creche cair, os responsáveis não recebem alertas até voltar (a portaria continua funcionando pela fila) |

Em qualquer caso o **celular da portaria** é separado: ele só precisa de
internet (Wi-Fi da creche ou dados móveis) para falar com o servidor.

Ambas as opções usam o mesmo `docker compose`; a diferença está em quem faz o
HTTPS (Caddy no VPS; Cloudflare no túnel). Veja a seção 3.

## 2. Domínio e HTTPS

Você precisa de um **nome de domínio** (ex.: `creche.suacidade.sp.gov.br` ou
`crechesegura.com.br`) apontando para o servidor. Peça à prefeitura um
subdomínio do domínio oficial ou registre um no Registro.br (cerca de
R$ 40/ano).

**HTTPS é obrigatório**, não opcional. Sem HTTPS o navegador bloqueia
exatamente o que o sistema usa:

| Recurso | Sem HTTPS |
| --- | --- |
| Leitor NFC (Web NFC) | não funciona |
| Câmera para ler QR Code | não funciona |
| Notificações push | não funcionam |
| Service worker (modo offline, "instalar na tela inicial", atualização automática) | não funciona |
| Senhas e tokens trafegando na rede | ficam expostos |

A única exceção é `http://localhost`, usada só em desenvolvimento.

Com o `docker-compose.yml` deste repositório, o **Caddy** obtém e renova o
certificado sozinho (Let's Encrypt). Para isso:

1. No painel do seu DNS, crie um registro **A** com o nome do domínio apontando
   para o IP público do servidor (e um **AAAA** se tiver IPv6).
2. Libere as portas **80** e **443** no firewall do servidor/provedor.
3. Informe o domínio em `DOMAIN=` no `.env` (o Caddy lê essa variável).
4. Espere o DNS propagar (`ping creche.exemplo.com.br` deve responder com o IP
   do servidor) **antes** de subir o compose — o Let's Encrypt precisa
   alcançar o servidor pelo nome.

Com **Cloudflare Tunnel** o HTTPS é feito pela Cloudflare e o Caddy não é
usado (veja 3.3).

## 3. Instalação com Docker Compose

### 3.1 Preparar o servidor

No Ubuntu 24.04 (VPS ou computador da creche):

```bash
sudo apt update && sudo apt install -y git curl
curl -fsSL https://get.docker.com | sudo sh      # instala Docker + docker compose
sudo usermod -aG docker $USER && newgrp docker    # usar docker sem sudo
```

Baixe o projeto (substitua pela URL do seu repositório ou copie a pasta):

```bash
git clone <url-do-repositorio> creche-segura
cd creche-segura
```

### 3.2 Configurar

```bash
cp .env.example .env
nano .env          # ou outro editor
```

Preencha pelo menos (todas as variáveis estão explicadas na seção 4):

```ini
APP_URL=https://creche.exemplo.com.br
DOMAIN=creche.exemplo.com.br          # usado pelo Caddy (adicione esta linha)
TZ=America/Sao_Paulo
DAYCARE_NAME=Creche Municipal Pequeno Príncipe
DAYCARE_PHONE=(11) 4002-8922
CONTACT_EMAIL=secretaria@exemplo.com.br
ADMIN_NAME=Direção
ADMIN_EMAIL=direcao@exemplo.com.br
ADMIN_PASSWORD=uma-senha-longa-e-diferente-do-exemplo
```

E, se já tiver os dados do e-mail, as linhas `SMTP_*` e `MAIL_FROM` (seção 5).

Crie a pasta de dados **antes** de subir e entregue-a ao usuário do
container (o servidor roda como usuário `node`, id 1000; sem isso ele não
consegue gravar o banco):

```bash
mkdir -p data
sudo chown -R 1000:1000 data
```

Nessa pasta ficarão `creche.sqlite` (o banco), `uploads/` (fotos) e
`backups/`. É ela que você precisa guardar.

### 3.3 Subir

**VPS com Caddy (padrão):**

```bash
docker compose up -d --build
docker compose logs -f app        # aguarde "Creche Segura no ar"; Ctrl+C sai do log
```

Acesse `https://creche.exemplo.com.br/login`. O primeiro acesso ao domínio pode
levar alguns segundos enquanto o Caddy emite o certificado.

**Computador na creche com Cloudflare Tunnel:**

1. Crie uma conta na Cloudflare e adicione seu domínio (ou use um subdomínio de
   um domínio que já esteja na Cloudflare).
2. Em *Zero Trust → Networks → Tunnels*, crie um túnel, instale o `cloudflared`
   no computador com o comando que a tela mostra (`cloudflared service
   install <token>`) e adicione um *Public hostname*:
   `creche.exemplo.com.br` → serviço `http://localhost:3000`.
3. Publique a porta do app só para o próprio computador. Crie um arquivo
   `docker-compose.override.yml` ao lado do `docker-compose.yml`:

   ```yaml
   services:
     app:
       ports:
         - "127.0.0.1:3000:3000"
   ```

4. Suba só o app (o Caddy não é necessário):

   ```bash
   docker compose up -d --build app
   ```

`TRUST_PROXY` já vem como `true` no compose, então os limites por IP usam o
endereço real do visitante em vez do IP do túnel/proxy.

### 3.4 Comandos do dia a dia

| Tarefa | Comando |
| --- | --- |
| Ver se está rodando | `docker compose ps` |
| Ver o log do servidor | `docker compose logs -f app` |
| Reiniciar | `docker compose restart app` |
| Parar tudo | `docker compose down` (os dados ficam em `./data`) |
| Dados de demonstração (só para testar!) | `docker compose exec app node server/dist/seed.js` e depois `... seed.js --clean` |
| Retenção LGPD | `docker compose exec app node server/dist/purge.js` |
| Restaurar backup | seção 8 |

## 4. Variáveis de ambiente, uma a uma

O servidor lê o arquivo `.env` (na raiz do projeto). Valores em branco contam
como "não informado" e o padrão é usado. Booleanos aceitam `true/false`, `1/0`,
`yes/no`, `on/off`, `sim/nao`.

Três variáveis (`DAYCARE_NAME`, `DAYCARE_PHONE`, `CONTACT_EMAIL`) e as chaves
`VAPID_*` **só semeiam o banco na primeira execução**; depois disso o que vale é
o que está no painel (Configurações) e no banco. Mudar essas linhas no `.env`
depois não tem efeito.

| Variável | Padrão | Para que serve |
| --- | --- | --- |
| `APP_URL` | `http://localhost:5173` | Endereço público do app, com `https://`. Entra nos links de e-mail e de convite, no QR das carteirinhas (`https://<APP_URL>/c/<código>`) e nas notificações push. **Obrigatório em produção.** |
| `DOMAIN` | `creche.exemplo.com.br` | Só para o Caddy do `docker-compose.yml`: o domínio para o qual ele emite o certificado. Deve ser o mesmo host de `APP_URL`. |
| `PORT` | `3000` | Porta em que o servidor escuta. No Docker deixe 3000. |
| `HOST` | `0.0.0.0` | Endereço de escuta. `127.0.0.1` restringe ao próprio computador (útil sem Docker com Caddy na mesma máquina). |
| `TRUST_PROXY` | `false` | `true` quando há Caddy, Nginx ou Cloudflare na frente: o servidor passa a usar `X-Forwarded-For` para saber o IP real (limites de tentativas de login por IP e auditoria). O compose já força `true`. |
| `DATA_DIR` | `./data` (relativo à pasta `server/`) | Onde ficam `creche.sqlite`, `uploads/` e `backups/`. No Docker é `/data` (montado de `./data`). |
| `WEB_DIST` | `../web/dist` | Pasta do app compilado que o servidor serve. No Docker é `/app/web/dist`. Em desenvolvimento não é usada (o Vite serve o app). |
| `TZ` | `America/Sao_Paulo` | Fuso horário da creche. Define o "dia" dos relatórios, o horário do backup (02:00) e as horas mostradas nos alertas. Precisa ser um nome válido da base IANA; o servidor recusa iniciar com um valor desconhecido. |
| `DAYCARE_NAME` | `Creche Municipal` | Nome da creche: aparece no app, nas carteirinhas e no assunto dos e-mails (`[Nome]`). Editável no painel depois. |
| `DAYCARE_PHONE` | vazio | Telefone impresso nas carteirinhas, mostrado na tela "NÃO LIBERAR" e nos alertas de exceção ("ligue agora para a creche"). Editável no painel. |
| `CONTACT_EMAIL` | vazio | E-mail de contato: vira o "responder para" dos e-mails enviados e recebe o e-mail de teste quando o administrador não tem e-mail. Editável no painel. |
| `ADMIN_NAME` | `Direção` | Nome do administrador inicial. |
| `ADMIN_EMAIL` | vazio | E-mail (login) do administrador inicial. Usado **apenas** quando ainda não existe nenhum administrador no banco. |
| `ADMIN_PASSWORD` | vazio | Senha do administrador inicial. **Mínimo 12 caracteres e diferente de `troque-esta-senha`**; caso contrário o servidor se recusa a iniciar. Depois de criar o administrador, pode apagar a linha. |
| `SMTP_HOST` | vazio | Servidor de e-mail. Vazio = e-mails desligados (o sistema funciona; convites saem por WhatsApp/QR e os alertas por push e app). |
| `SMTP_PORT` | `587` | Porta SMTP. `587` com `SMTP_SECURE=false` (STARTTLS) é o mais comum; `465` com `SMTP_SECURE=true`. |
| `SMTP_SECURE` | `false` | `true` = TLS direto (porta 465). `false` = o servidor **exige** STARTTLS na conexão (nunca envia a senha em claro). |
| `SMTP_USER` | vazio | Usuário do SMTP (no Gmail, o endereço completo). Vazio = sem autenticação (só para relays internos). |
| `SMTP_PASS` | vazio | Senha do SMTP (no Gmail, a **senha de app**, não a senha da conta). |
| `MAIL_FROM` | `Creche Segura <no-reply@localhost>` | Remetente dos e-mails. **Precisa ser a caixa autenticada** (ou um remetente validado no provedor), senão o provedor recusa ou os e-mails caem no spam. Ex.: `"Creche Pequeno Príncipe <creche.pp@gmail.com>"`. |
| `SMTP_DAILY_LIMIT` | `450` | Máximo de e-mails por dia. Ao chegar nele, e-mails de rotina são pulados e só as exceções continuam (seção 5.5). Deixe abaixo do limite do provedor. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | geradas | Chaves das notificações push. Deixe em branco: são geradas na primeira execução e guardadas no banco. Só preencha se quiser reaproveitar chaves de outra instalação (e antes da primeira execução). |
| `VAPID_SUBJECT` | `mailto:<ADMIN_EMAIL>` | Contato que os serviços de push (Google/Apple/Mozilla) podem usar para falar com você. |
| `NOTIFY_HOLD_SECONDS` | `45` | Janela para **Desfazer** um registro antes de qualquer alerta ser enviado. |
| `SESSION_TTL_DAYS` | `30` | Validade da sessão (login) renovada a cada uso. |
| `SESSION_MAX_DAYS` | `90` | Teto absoluto de uma sessão, mesmo em uso. |
| `OFFLINE_CHECKOUT_MAX_AGE_HOURS` | `12` | Idade máxima dos dados locais do celular da portaria para permitir uma **SAÍDA sem internet**. |
| `BACKUP_KEEP_DAYS` | `14` | Quantos dias de backups automáticos ficam em `backups/`. |
| `RETENTION_MONTHS` | `24` | Meses após o desligamento de uma criança para o `purge` anonimizá-la. |
| `LOG_LEVEL` | `info` | `debug` para investigar problemas; `warn` para menos ruído. |

## 5. E-mail

Os e-mails são usados para: convites e redefinição de senha, alertas de saída
(sempre, para quem tem e-mail), alertas de entrada (se o responsável quiser),
exceções, recusas, cancelamentos e avisos administrativos.

### 5.1 Escolher o provedor

| Provedor | Limite gratuito | Configuração |
| --- | --- | --- |
| **Gmail com senha de app** (o mais simples para começar) | ~500 e-mails/dia por conta (Google Workspace: 2.000) | Crie uma conta Gmail própria da creche. Ative a *Verificação em duas etapas* (Conta Google → Segurança), depois em *Senhas de app* gere uma senha para "Creche Segura" (16 letras). `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER=creche.pp@gmail.com`, `SMTP_PASS=<senha de app sem espaços>`, `MAIL_FROM="Creche PP <creche.pp@gmail.com>"`, `SMTP_DAILY_LIMIT=450`. |
| **Brevo** (ex-Sendinblue) | 300 e-mails/dia | Crie a conta, valide um remetente (ou autentique seu domínio) e em *SMTP & API* gere uma **chave SMTP**. `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER=<e-mail de login da conta Brevo>`, `SMTP_PASS=<chave SMTP>`, `MAIL_FROM="Creche PP <remetente validado>"`, `SMTP_DAILY_LIMIT=280`. |
| **Amazon SES** | pago (centavos por mil e-mails); exige sair do *sandbox* | Verifique o domínio ou o remetente no SES, crie *credenciais SMTP* (usuário e senha específicos do SES, não as chaves IAM), peça saída do sandbox. `SMTP_HOST=email-smtp.sa-east-1.amazonaws.com` (ou a região usada), `SMTP_PORT=587`, `SMTP_SECURE=false`, `MAIL_FROM` = remetente verificado, `SMTP_DAILY_LIMIT` conforme a cota concedida. |

Uma creche com 150 crianças gera por dia cerca de 150 saídas × 2
responsáveis = 300 e-mails de saída, mais as entradas de quem pediu. Se isso
passar do limite gratuito, contrate um plano (Brevo) ou use o SES.

### 5.2 `MAIL_FROM` deve ser a caixa autenticada

O remetente (`MAIL_FROM`) precisa ser o mesmo endereço com o qual você se
autentica (Gmail) ou um remetente/domínio validado no provedor (Brevo, SES).
Colocar `no-reply@prefeitura.gov.br` sem autorização do domínio faz o
provedor recusar o envio ou os destinatários marcarem como spam.

O campo "responder para" dos e-mails é o **E-mail de contato** configurado no
painel; use o e-mail da secretaria para que respostas dos pais cheguem a quem
pode atender.

### 5.3 SPF e DKIM

Se você usa **domínio próprio** (Brevo ou SES), cadastre no DNS os registros
que o provedor mostra: um `TXT` de **SPF** (diz que o provedor pode enviar em
nome do domínio) e um `CNAME`/`TXT` de **DKIM** (assina os e-mails). Sem eles,
Gmail e Outlook jogam os alertas no spam ou rejeitam. Com Gmail como
remetente, o Google já cuida disso.

### 5.4 Testar

1. Entre como administrador → **Configurações**.
2. No cartão **E-mail**, o estado deve ser "ativo" (se estiver "desligado",
   `SMTP_HOST` está vazio ou o servidor não foi reiniciado após editar o
   `.env`).
3. Toque em **Enviar e-mail de teste**. Ele vai para o e-mail do
   administrador logado (ou para o e-mail de contato, se o administrador não
   tiver e-mail). Se falhar, a mensagem de erro do provedor aparece na tela
   ("Falha ao enviar: …") — os motivos mais comuns estão na seção 12.
4. Peça a um responsável para ativar o e-mail de entrada nas preferências e
   verifique se ele recebe.

### 5.5 Limite diário e retentativas

- O servidor conta os e-mails **enviados no dia** (dia civil no fuso `TZ`).
  Ao atingir `SMTP_DAILY_LIMIT`, e-mails de rotina (entrada, saída normal,
  convites de lote) ficam como "pulado (cota)"; **exceções, recusas, conflitos
  e carteirinha revogada continuam saindo**. Os administradores recebem um
  aviso no app/push uma vez por dia, e o painel mostra "E-mails hoje" e
  "Puladas (cota)".
- Erros temporários do provedor (respostas 4xx, timeout) são retentados após
  60 s e 300 s; na terceira falha o e-mail fica como "falhou". Erros
  permanentes (endereço inexistente, autenticação recusada) falham na hora e o
  responsável recebe o selo "última falha de e-mail" na lista de
  Responsáveis — corrija o endereço e reenvie o convite.
- Push e alertas no app **não** dependem do e-mail.

## 6. Notificações push

- As chaves (VAPID) são **geradas sozinhas** na primeira execução e ficam no
  banco (`settings`). Não há nada para cadastrar em Google ou Apple. Se o
  banco for restaurado de um backup, as chaves vêm junto e as inscrições dos
  responsáveis continuam válidas. Se você **apagar o banco** e começar do
  zero, novas chaves são geradas e cada responsável precisa tocar de novo em
  "Ativar notificações".
- O painel → **Configurações** → *Notificações push* mostra "Chaves VAPID:
  configuradas" e permite ativar e testar o push no próprio aparelho do
  administrador.
- **Android**: funciona no Chrome (e derivados) direto no navegador; instalar
  na tela inicial é recomendado para o app abrir mais rápido.
- **iPhone/iPad**: só recebe push com o app **instalado na tela inicial**
  (Safari → Compartilhar → "Adicionar à Tela de Início", iOS 16.4 ou mais
  novo) e aberto pelo ícone. A tela de convite e a de Configurações orientam
  isso automaticamente quando detectam um iPhone.
- Cada inscrição push pertence ao aparelho e à sessão que a criou: "Sair" ou a
  troca de senha desativa o push daquele aparelho até ativar de novo.
- Push de saída é enviado com prioridade alta; economizadores de bateria
  agressivos podem atrasar a entrega em alguns aparelhos — o e-mail e o app
  continuam sendo a referência.

## 7. Primeira execução e administrador inicial

Na primeira vez que o servidor sobe ele:

1. cria `DATA_DIR/creche.sqlite`, `uploads/` e `backups/` e aplica o esquema
   do banco (isso também acontece a cada atualização, sem apagar nada);
2. grava as configurações iniciais (nome, telefone e e-mail da creche do
   `.env`, chaves de push, segredo das fotos);
3. cria o **administrador inicial** com `ADMIN_NAME`, `ADMIN_EMAIL` e
   `ADMIN_PASSWORD` — **somente se ainda não existir nenhum administrador**.

O servidor **recusa iniciar** e mostra o motivo no log quando:

- `ADMIN_PASSWORD` é `troque-esta-senha` (a do exemplo) ou tem menos de 12
  caracteres: `ADMIN_PASSWORD precisa ter pelo menos 12 caracteres e ser
  diferente da senha do exemplo`;
- não existe administrador e `ADMIN_EMAIL` está vazio.

Depois de entrar pela primeira vez:

1. **Configurações** → troque a senha do administrador (mínimo 12 caracteres)
   e confira nome, telefone e e-mail de contato da creche.
2. **Enviar e-mail de teste** e **Ativar notificações** (push) para validar os
   dois canais.
3. **Equipe** → cadastre as vigilantes: nome, *login curto* (ex.: `carlos`),
   senha (mínimo 8) e **PIN de troca rápida** (4 a 6 dígitos). Cadastre outros
   administradores se necessário (senha mínima 12).
4. **Crianças** (ou **Importar**, com a planilha modelo `modelo-importacao.csv`
   baixada da própria tela) → crianças, responsáveis, parentesco, quem pode
   retirar, fotos e o consentimento LGPD.
5. **Carteirinhas** → gerar em lote, imprimir e, se quiser, colar as etiquetas
   NFC ([CARTEIRINHAS.md](CARTEIRINHAS.md)).
6. Envie os convites aos responsáveis (por e-mail, WhatsApp ou QR no balcão) e
   entregue o [guia dos responsáveis](RESPONSAVEIS.md).
7. Prepare o celular da portaria ([PORTARIA.md](PORTARIA.md)).

Se você rodou o seed para conhecer o sistema, remova os dados fictícios antes
de cadastrar dados reais: `docker compose exec app node server/dist/seed.js
--clean` (o banner "DADOS DE DEMONSTRAÇÃO" some).

## 8. Backup e restauração

### 8.1 O que precisa ser guardado

Tudo está em `DATA_DIR` (`./data` ao lado do compose):

| Item | Conteúdo |
| --- | --- |
| `creche.sqlite` (+ `-wal`, `-shm`) | o banco: cadastros, eventos, alertas, chaves de push, configurações |
| `uploads/` | fotos de crianças e responsáveis |
| `backups/` | cópias automáticas do banco |

### 8.2 Backup automático

Todo dia às **02:00** (fuso `TZ`) o servidor grava
`backups/creche-AAAA-MM-DD-HHmm.sqlite` (uma cópia consistente do banco, mesmo
com o sistema em uso) e apaga as mais antigas que `BACKUP_KEEP_DAYS` (14). O
painel mostra **Último backup** e fica vermelho se passou de 48 h — sinal de
que o servidor ficou desligado nesse horário ou o disco encheu.

Em **Configurações → Backup** há dois botões:

- **Executar backup agora** — gera um snapshot na hora.
- **Baixar último backup** — gera um snapshot novo e baixa um
  `creche-backup-<data>.tar.gz` com o banco **e** a pasta `uploads/` (fotos).
  Precisa do utilitário `tar` no servidor (a imagem Docker já tem).

### 8.3 Guarde uma cópia fora do servidor

O backup automático protege contra erro de operação, não contra o servidor
sumir. Faça pelo menos um destes:

- toda semana, **Baixar último backup** pelo painel e guardar o arquivo num
  Drive/OneDrive da creche ou num pendrive trancado (o arquivo contém dados
  pessoais de crianças — trate como documento sigiloso);
- ou automatize no servidor, por exemplo com `cron` + `rclone` para uma nuvem:

  ```bash
  # crontab -e  (todo dia 03:00, depois do backup das 02:00)
  0 3 * * * tar czf /tmp/creche-$(date +\%F).tar.gz -C /home/usuario/creche-segura data && rclone copy /tmp/creche-$(date +\%F).tar.gz drive:backups-creche && rm /tmp/creche-$(date +\%F).tar.gz
  ```

Teste a restauração pelo menos uma vez (num computador de teste) para ter
certeza de que o arquivo serve.

### 8.4 Restaurar

`npm run restore` substitui o banco por um snapshot `.sqlite`. Ele exige o
servidor **parado**, confirma com `--yes` e preserva o banco atual como
`creche.sqlite.before-restore-<data>`.

**Com Docker:**

```bash
# 1) o arquivo precisa estar dentro de ./data (por exemplo em ./data/backups/)
docker compose stop app
docker compose run --rm app node server/dist/restore.js /data/backups/creche-2026-09-10-0200.sqlite --yes
docker compose start app
```

**Sem Docker** (na pasta do projeto, servidor parado):

```bash
npm run restore -w server -- /caminho/completo/creche-2026-09-10-0200.sqlite --yes
```

Se o ponto de partida é um `creche-backup-<data>.tar.gz` baixado pelo painel:

```bash
mkdir -p /tmp/restaurar && tar xzf creche-backup-2026-09-10-0200.tar.gz -C /tmp/restaurar
# /tmp/restaurar/backups/creche-2026-09-10-0200.sqlite  → use no restore (copie para ./data/backups/ se for via Docker)
# /tmp/restaurar/uploads/                               → copie para ./data/uploads/ (fotos)
sudo cp -a /tmp/restaurar/uploads/. ./data/uploads/ && sudo chown -R 1000:1000 ./data
```

O `restore` cuida só do banco; as fotos são copiadas à mão como acima. Depois
de restaurar, abra o painel e confira "Último backup", a lista de crianças e
uma foto qualquer.

## 9. Atualização de versão

```bash
cd creche-segura
git pull                                  # ou copie a nova versão por cima
docker compose build app && docker compose up -d app
docker compose logs -f app                # "Creche Segura no ar"
```

O esquema do banco é atualizado automaticamente na subida (nada é apagado).
Faça um backup antes por precaução (**Executar backup agora**).

O que os usuários veem:

- o app da portaria mostra a faixa **"Nova versão — toque para atualizar"**
  e, se estiver ocioso na tela de Leitura (sem confirmação aberta, sem janela
  de desfazer e com a fila vazia), recarrega sozinho;
- responsáveis e painel recebem a mesma faixa ao abrir o app;
- em **Configurações → Sobre** aparecem "Versão do app (servidor)" e "Versão
  carregada neste navegador" — devem coincidir após a atualização.

Sem Docker: `git pull && npm ci && npm run build && sudo systemctl restart
creche-segura` (seção 11).

## 10. Retenção de dados (`npm run purge`)

O script de retenção aplica a política do [LGPD.md](LGPD.md):

- anonimiza crianças **desativadas** há mais de `RETENTION_MONTHS` (24) meses
  (nome vira "Criança removida #NNNN"; nascimento, observações, foto,
  consentimento e carteirinhas são removidos; os eventos ficam, já
  anonimizados);
- apaga registros de tentativas de login com mais de 24 h;
- apaga números de documento de terceiros (exceções e autorizações avulsas)
  com mais de 12 meses.

Rode uma vez por mês:

```bash
docker compose exec app node server/dist/purge.js     # Docker
npm run purge -w server                               # sem Docker
```

Ou agende (`crontab -e`, todo dia 1º às 04:00):

```
0 4 1 * * cd /home/usuario/creche-segura && docker compose exec -T app node server/dist/purge.js >> /var/log/creche-purge.log 2>&1
```

O script imprime quantos registros tratou. A anonimização é irreversível; ela
só alcança crianças já desativadas pela direção há mais de 24 meses.

## 11. Instalação sem Docker

Para quem prefere rodar direto no sistema (Ubuntu/Debian):

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs build-essential python3
# projeto
git clone <url> /opt/creche-segura && cd /opt/creche-segura
cp .env.example .env && nano .env        # DATA_DIR=/var/lib/creche-segura, HOST=127.0.0.1, TRUST_PROXY=true
npm ci && npm run build
sudo mkdir -p /var/lib/creche-segura && sudo chown $USER /var/lib/creche-segura
npm start                                 # teste; Ctrl+C para parar
```

Serviço `systemd` (`/etc/systemd/system/creche-segura.service`):

```ini
[Unit]
Description=Creche Segura
After=network.target

[Service]
User=creche
WorkingDirectory=/opt/creche-segura
ExecStart=/usr/bin/node server/dist/index.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin creche && sudo chown -R creche /opt/creche-segura /var/lib/creche-segura
sudo systemctl enable --now creche-segura && journalctl -u creche-segura -f
```

HTTPS com Caddy instalado no sistema (`sudo apt install caddy`),
`/etc/caddy/Caddyfile`:

```
creche.exemplo.com.br {
	encode zstd gzip
	reverse_proxy localhost:3000
}
```

`sudo systemctl reload caddy`. Os scripts `seed`, `purge` e `restore` rodam
como `node server/dist/seed.js` etc. a partir de `/opt/creche-segura`.

## 12. Solução de problemas

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| O servidor não sobe; log diz `ADMIN_PASSWORD precisa ter pelo menos 12 caracteres…` | Senha do exemplo ou curta | Edite `ADMIN_PASSWORD` no `.env` e suba de novo. Só é lida enquanto não existir administrador. |
| Log diz `Nenhum administrador existe e ADMIN_EMAIL não foi informado` | `.env` sem `ADMIN_EMAIL` | Preencha e reinicie. |
| `EACCES`/`SQLITE_CANTOPEN` ao subir com Docker | `./data` pertence ao root | `sudo chown -R 1000:1000 data` e `docker compose restart app`. |
| Site não abre / certificado inválido | DNS ainda não aponta para o servidor, portas 80/443 fechadas ou `DOMAIN` errado | Confira `ping <domínio>`, o firewall e `docker compose logs caddy`. |
| **E-mails não chegam** e o cartão E-mail diz "desligado" | `SMTP_HOST` vazio ou servidor não reiniciado | Preencha e `docker compose restart app`. |
| "Falha ao enviar: Invalid login / 535" | Senha errada; no Gmail, senha da conta em vez de senha de app; verificação em duas etapas desligada | Gere a senha de app; confira `SMTP_USER`. |
| "Falha ao enviar: … sender rejected / not verified" | `MAIL_FROM` não é a caixa autenticada/validada | Use o mesmo endereço do `SMTP_USER` (Gmail) ou valide o remetente (Brevo/SES). |
| Teste passa, mas os pais não recebem | Caiu no spam (falta SPF/DKIM) ou e-mail errado no cadastro | Configure SPF/DKIM; veja o selo "última falha de e-mail" em Responsáveis. |
| E-mails param de sair à tarde | Cota diária (`SMTP_DAILY_LIMIT`) atingida — painel mostra "Puladas (cota)" | Aumente o plano do provedor ou reduza os e-mails de entrada (preferência dos responsáveis). Exceções continuam saindo. |
| **Push não chega** | Responsável não ativou; iPhone sem instalar na tela inicial; notificações bloqueadas no navegador; economia de bateria | Configurações → "Ativar notificações" → "Enviar teste". Painel → Configurações confere "Chaves VAPID: configuradas". |
| Push parou para todo mundo após reinstalar | Banco novo = chaves VAPID novas | Restaure o banco antigo ou peça para todos reativarem. |
| **NFC não lê** | Não é Chrome/Android; NFC desligado; permissão do site negada; a carteirinha não tem etiqueta ou a etiqueta não foi vinculada | Ligue o NFC nas configurações; toque em "Toque para ativar o leitor"; no cadeado da barra de endereço libere NFC; confira no painel se a carteirinha tem "NFC". Sem NFC use QR/código/nome. |
| "Carteirinha ilegível, tente de novo" | Leitura interrompida | Encoste de novo, parado, na parte de trás do celular (perto da câmera na maioria dos aparelhos). |
| "Carteirinha não reconhecida" | Código digitado errado, carteirinha de outra instalação, ou cadastro ainda não baixado pelo celular | Confira o código (nunca há 0, O, 1, I, L); toque em "Atualizar" no rodapé da Leitura; use a busca por nome. |
| "Carteirinha cancelada — avise a direção" | Carteirinha revogada (perdida e substituída) | Entregue a nova; a antiga deve ser recolhida. |
| **"Carteirinha inconsistente — avise a direção"** | O código impresso e a etiqueta NFC apontam para carteirinhas diferentes (etiqueta colada na carteirinha errada ou trocada) | A direção revoga as duas carteirinhas envolvidas e gera novas; a etiqueta é vinculada de novo. Use a busca por nome até lá. |
| "Pessoa desligada da creche — avise a direção" | Responsável/criança desativado(a) ou anonimizado(a) | Direção confere o cadastro. |
| **Portaria sem internet** | Wi-Fi/dados caíram | Entradas continuam normais (ficam na fila). Saída exige um segundo toque "Confirmar mesmo assim" e é recusada se os dados locais tiverem mais de 12 h — nesse caso ligue para a secretaria ou use a folha de papel. Registros são enviados quando a conexão volta. |
| **Fila pendente** — chip "N aguardando envio" vermelho, painel diz "N na fila" | Sem conexão há mais de 10 min, ou a sessão expirou ("aguardando login") | Reconecte e toque no chip "Enviar agora"; se pedir login, entre de novo (a fila não se perde). "Sair" é recusado enquanto houver itens pendentes. |
| Item "não aplicado — veja em Hoje" | Registro da fila rejeitado pelo servidor (ex.: criança já tinha saído, carteirinha revogada) | Em **Hoje → Não aplicados**, leia o motivo e toque em "Dispensar"; se necessário registre de novo ou peça à secretaria para lançar. |
| "Muitas tentativas. Aguarde…" no login ou na troca por PIN | 5 senhas erradas em 15 min (por conta) ou 20 por IP; 5 PINs errados na sessão | Aguarde 15 min ou entre com login e senha. |
| "Último backup" vermelho no painel | Servidor desligado às 02:00 ou disco cheio | Toque em "Executar backup agora"; veja `docker compose logs app` e `df -h`. |
| "O utilitário tar não está instalado no servidor" | Instalação sem Docker em sistema mínimo | `sudo apt install tar`. |
| Banner "DADOS DE DEMONSTRAÇÃO" | O seed foi executado | `docker compose exec app node server/dist/seed.js --clean`. |
| Horários errados nos alertas | `TZ` incorreto | Ajuste `TZ` (ex.: `America/Manaus`, `America/Fortaleza`) e reinicie. Os registros guardam o instante exato; só a exibição muda. |
| Disco enchendo | Logs do Docker crescendo (as fotos não: o app reduz cada uma para 512 px) | `docker system prune` e, no `docker-compose.yml`, limite os logs do serviço `app` com `logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }`. |

Quando pedir ajuda a alguém, mande a saída de `docker compose logs --tail=200
app` (o log não contém senhas) e a versão mostrada em Configurações → Sobre.
