# LGPD — proteção de dados no Creche Segura

O sistema trata dados pessoais de crianças e de seus responsáveis. A Lei Geral
de Proteção de Dados (Lei nº 13.709/2018) exige cuidado extra com dados de
crianças (art. 14): o tratamento deve ser feito no melhor interesse da criança
e, quando baseado em consentimento, este deve ser específico, em destaque, e
dado por pelo menos um dos pais ou pelo responsável legal.

Este documento explica **o que o sistema guarda, quem vê o quê, quais
mecanismos existem para cumprir a lei** e traz um modelo de termo de
consentimento. A creche (ou a secretaria de educação) é a **controladora**
dos dados; o provedor de hospedagem, o de e-mail e o de push são operadores.

## 1. O que o sistema guarda

| Dado | De quem | Para quê | Onde |
| --- | --- | --- | --- |
| Nome, data de nascimento, turma, turno, foto | criança | identificar a criança na portaria, nos alertas e nos relatórios | `creche.sqlite` + pasta `uploads/` no servidor da creche |
| **Aviso de portaria** (curto, visível à vigilante) e **observações** (só administração) | criança | orientar a portaria (ex.: medida protetiva) e anotações da direção | idem |
| Registro de consentimento: data, nome e parentesco de quem assinou | criança / responsável | comprovar a base legal | idem |
| Nome, e-mail, telefone, foto, parentesco, "pode retirar", validade, bloqueio (e motivo, só administração) | responsável | identificar quem deixa/retira; enviar alertas | idem |
| Autorizações avulsas: nome, relação, telefone e documento (opcional) de quem vai buscar | terceiro indicado por um responsável | permitir a retirada por um dia | idem |
| Eventos de entrada/saída/recusa: horário, criança, quem deixou/retirou, quem registrou, método, exceções, cancelamentos | criança / responsável / vigilante | segurança e comprovação | idem |
| Nome e documento (opcional) de pessoa não cadastrada numa exceção | terceiro | registrar quem retirou fora da lista | idem — o documento nunca aparece nos alertas e é apagado após 12 meses |
| Notificações enviadas (texto, canal, status) | responsável | histórico de alertas no app; diagnóstico de entrega | idem |
| Inscrição push (endereço técnico do navegador), sessões (token em hash), tentativas de login (IP) | responsável / equipe | entregar alertas; autenticar; limitar tentativas | idem — tentativas de login são apagadas após 24 h |
| Log de auditoria: quem fez cada alteração administrativa, quando, de qual IP | equipe | responsabilização | idem |

Não há rastreadores, analytics nem venda de dados. Saem do servidor apenas:
os **e-mails** (para o provedor SMTP que a creche configurou) e as
**notificações push** (para o serviço do navegador — Google, Apple ou Mozilla
—, com o conteúdo **criptografado de ponta a ponta** no padrão Web Push; o
serviço vê só que há uma mensagem, não o texto). Se a creche usar Cloudflare
Tunnel ou um VPS, o provedor hospeda/transporta os dados como operador.

## 2. Quem vê o quê

O servidor monta uma "visão" diferente para cada papel; o que não está na
lista simplesmente não é enviado ao aparelho.

| | Vigilante (portaria) | Responsável | Administração |
| --- | --- | --- | --- |
| Crianças | todas as ativas: nome, foto, turma, status, **aviso de portaria** | só os próprios filhos | todas, inclusive inativas |
| Responsáveis | nome, foto, parentesco, pode retirar, validade, **bloqueado** (sem o motivo) | dos outros responsáveis do filho: só nome, parentesco e se pode retirar — **sem foto nem contato** | tudo, inclusive e-mail, telefone, motivo do bloqueio |
| E-mail e telefone | **não** | só os seus | sim |
| Observações da criança | **não** | **não** | sim |
| Autorizações avulsas | as válidas hoje (nome, relação, quem autorizou) | as dos próprios filhos | todas, com documento |
| Documento de terceiros (exceções/autorizações) | digita, mas não vê depois | **nunca** | sim |
| Histórico de eventos | últimos 7 dias | dos próprios filhos | completo, com exportação CSV |
| Fotos | por URL assinada, cache no celular da portaria | dos próprios filhos | sim |

O celular da portaria guarda uma cópia local (diretório) dessas informações
para funcionar sem internet — **sem** contatos nem observações. Qualquer
sessão encerrada (logout, senha trocada, conta desativada) apaga esse
diretório; a fila de registros pendentes é mantida até ser enviada.

## 3. Mecanismos do sistema

### 3.1 Registro de consentimento na ficha da criança

Em **Crianças → (criança) → Dados**, o bloco **Consentimento LGPD** guarda a
**data**, o **nome** e o **parentesco** de quem assinou o termo — e só aceita
**mãe, pai ou responsável legal** (art. 14, § 1º). O painel mostra o contador
**"Sem consentimento LGPD"** e o filtro correspondente na lista de crianças,
para a secretaria correr atrás das assinaturas que faltam. O termo assinado em
papel fica arquivado na creche; o sistema registra só quem/quando.

### 3.2 Minimização

- A carteirinha impressa traz só o primeiro nome e a inicial do sobrenome, a
  turma e o telefone da creche. A página pública da carteirinha (`/c/<código>`)
  mostra apenas o nome e o telefone da creche.
- A vigilante não vê contatos, observações nem o motivo de um bloqueio — só o
  aviso de portaria escrito pela direção para ela.
- O número de documento de terceiros nunca vai nos alertas (só "documento
  conferido pela portaria") e é apagado pelo `purge` após 12 meses.
- Fotos são reduzidas para 512 px no navegador antes do envio (isso também
  remove os metadados EXIF, como localização).
- Não cadastre CPF, endereço ou dados de saúde nas **observações** a menos que
  seja indispensável. O campo **aviso de portaria** é visto pela vigilante:
  escreva só a instrução ("Não entregar ao pai — chamar a direção"), sem
  número de processo.

### 3.3 Anonimização

Nada é apagado fisicamente do histórico (os eventos são a comprovação de
segurança). Em vez disso, a direção **desativa** e depois **anonimiza**:

- **Criança**: Crianças → (criança) → Mais → *Desativar* (se estiver presente,
  uma saída automática é registrada) e depois *Anonimizar (LGPD)* com um
  motivo. O nome vira "Criança removida #NNNN"; nascimento, aviso de portaria,
  observações, consentimento e foto são apagados; carteirinhas revogadas;
  autorizações revogadas e documentos apagados; vínculos removidos. Os eventos
  ficam, mas já com o nome anonimizado.
- **Responsável**: Responsáveis → (pessoa) → Acesso → *Desativar conta* e
  *Anonimizar*. O nome vira "Responsável removido #NNNN"; e-mail, telefone,
  senha, foto e inscrições push são apagados; sessões encerradas;
  carteirinhas revogadas; vínculos removidos.
- Tudo fica no log de auditoria (quem anonimizou, quando, motivo). A ação é
  irreversível.

### 3.4 Retenção e `npm run purge`

Política padrão: manter os registros de uma criança por **24 meses após o
desligamento** (`RETENTION_MONTHS`) — tempo razoável para eventuais
questionamentos sobre quem retirou a criança em determinado dia — e depois
anonimizar.

O script de retenção (`npm run purge -w server` ou, no Docker, `docker compose
exec app node server/dist/purge.js`) aplica isso automaticamente:

| O que | Prazo |
| --- | --- |
| Anonimiza crianças desativadas há mais de `RETENTION_MONTHS` (24) meses | mensal |
| Apaga tentativas de login (IP) | mais de 24 h (também roda de hora em hora no servidor) |
| Apaga números de documento de terceiros em exceções e autorizações avulsas | mais de 12 meses |

Agende-o mensalmente (veja [IMPLANTACAO.md](IMPLANTACAO.md), seção 10).
Responsáveis sem nenhuma criança ativa devem ser desativados/anonimizados pela
secretaria ao fim do ano letivo; sessões expiram sozinhas (30 dias sem uso, 90
no máximo).

### 3.5 Backup

O backup automático diário (`data/backups/`, 14 dias) e o arquivo baixado pelo
painel contêm **todos** os dados pessoais acima, inclusive fotos. Trate-os
como documento sigiloso:

- guarde as cópias externas em local de acesso restrito (conta da creche na
  nuvem com senha forte e verificação em duas etapas, ou pendrive trancado);
- não envie backups por WhatsApp ou e-mail pessoal;
- apague cópias antigas: a retenção do backup não deve ultrapassar a retenção
  dos dados;
- ao restaurar um backup antigo, dados já anonimizados **voltam** — rode o
  `purge` em seguida.

### 3.6 Segurança técnica

- HTTPS obrigatório; senhas com scrypt; tokens de sessão, convite e
  redefinição guardados como hash; limite de tentativas de login (5 por conta
  e 20 por IP a cada 15 min) e de PIN (5 por sessão).
- Fotos servidas apenas por URL assinada; uploads verificados pelo conteúdo
  (JPEG/PNG/WebP), nunca SVG.
- Trocar a senha encerra as outras sessões; desativar ou anonimizar encerra
  todas e remove as inscrições push.
- Auditoria (`Auditoria` no painel) de toda mutação administrativa: cadastros,
  vínculos, bloqueios, autorizações, carteirinhas, fotos, senhas,
  configurações, cancelamentos, anonimizações, importações, backups.
- O celular da portaria deve ter bloqueio de tela e ficar sob guarda da
  vigilante; ao fim do dia, **Trocar** para a vigilante seguinte ou manter o
  aparelho na secretaria.

## 4. Boas práticas para a creche

1. **Base legal**: colha o termo abaixo assinado (papel) de um dos pais ou do
   responsável legal **antes** de cadastrar a criança, e registre quem/quando
   na ficha (3.1). Informe às demais pessoas autorizadas (avós, tios) que seus
   nome, foto e parentesco serão cadastrados para a conferência na portaria —
   o termo já prevê isso.
2. **Mínimo necessário** (3.2).
3. **Acesso**: só a direção/secretaria tem conta de administração; cada
   vigilante tem a sua (não compartilhe senhas nem PINs); responsáveis só
   veem os próprios filhos.
4. **Retenção**: desative crianças que saíram; rode o `purge` mensalmente
   (3.4).
5. **Backup** guardado com sigilo (3.5).
6. **Incidentes**: perda do celular da portaria → a direção encerra as sessões
   da vigilante em **Equipe** (na próxima tentativa de conexão o app apaga o
   diretório local; até lá, o bloqueio de tela do aparelho é a proteção — por
   isso ele é obrigatório). Vazamento de dados → comunicar a ANPD e os
   responsáveis conforme o art. 48.
7. **Direitos do titular**: o responsável pode pedir acesso (o app já mostra
   os dados dos filhos), correção (secretaria edita), exclusão (desativar +
   anonimizar) e informação sobre o tratamento (este documento). Responda em
   até 15 dias.
8. **Encarregado (DPO)**: indique uma pessoa da direção ou da secretaria de
   educação como contato para assuntos de dados e coloque o contato no termo.

## 5. Modelo de termo de consentimento

> **TERMO DE CONSENTIMENTO PARA TRATAMENTO DE DADOS PESSOAIS**
> **Creche:** ______________________________________
> **Encarregado(a) pelos dados / contato:** ____________________________
>
> Eu, ______________________________________, portador(a) do documento
> nº ______________, na condição de ☐ mãe ☐ pai ☐ responsável legal da
> criança ______________________________________, nascida em ___/___/______,
> autorizo a creche acima a coletar e tratar os seguintes dados para fins de
> **controle de entrada e saída da criança e envio de alertas de segurança
> aos responsáveis**, por meio do sistema Creche Segura:
>
> - da criança: nome, data de nascimento, turma, turno e fotografia;
> - dos responsáveis e das pessoas autorizadas a retirar: nome, e-mail,
>   telefone, fotografia, grau de parentesco e, quando houver, restrições
>   determinadas pela direção ou por decisão judicial;
> - de pessoas que eu autorizar pontualmente a buscar a criança: nome,
>   relação, telefone e, opcionalmente, número de documento;
> - registros de horário de entrada e saída, com identificação de quem deixou
>   e quem retirou a criança, e das tentativas de retirada recusadas.
>
> Estou ciente de que: (i) os dados ficam armazenados em servidor sob
> responsabilidade da creche, e os alertas são enviados por e-mail e por
> notificação no celular através dos provedores desses serviços; (ii) a
> portaria vê apenas nome, foto, parentesco e autorização de retirada; (iii)
> posso solicitar acesso, correção ou exclusão dos dados a qualquer momento
> junto à secretaria; (iv) os dados serão mantidos enquanto a criança estiver
> matriculada e por até 24 meses após o desligamento, sendo então
> anonimizados; (v) as pessoas que indicarei como autorizadas a retirar a
> criança serão informadas deste tratamento; (vi) a carteirinha com QR Code /
> etiqueta NFC identifica a criança ou o responsável na portaria e, em caso de
> perda, devo comunicar a creche para cancelamento.
>
> Pessoas autorizadas a retirar a criança:
> 1. Nome: __________________ Parentesco: ________ Tel.: ____________
> 2. Nome: __________________ Parentesco: ________ Tel.: ____________
> 3. Nome: __________________ Parentesco: ________ Tel.: ____________
>
> Local e data: ____________________, ___/___/______
>
> Assinatura: ______________________________________

Depois de assinado, registre na ficha da criança (**Consentimento LGPD**: data,
nome e parentesco de quem assinou) e arquive o papel.
