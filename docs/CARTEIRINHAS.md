# Carteirinhas — como emitir, imprimir, colar NFC e substituir

A carteirinha é o que a portaria lê. Cada uma tem:

- um **código** de 8 caracteres impresso (ex.: `7K3P-2Q9M`), sem os caracteres
  que se confundem (`0`, `O`, `1`, `I`, `L`);
- um **QR Code** com o endereço `https://<seu-domínio>/c/7K3P2Q9M`;
- opcionalmente uma **etiqueta NFC** colada, que a vigilante só encosta no
  celular.

A carteirinha pertence a **um responsável** ou a **uma criança**. Se for
perdida, ela é **revogada** (nunca apagada) e uma nova é gerada — o código e a
etiqueta antigos param de funcionar juntos.

## 1. Carteirinha de criança ou de responsável?

| | Carteirinha da **criança** | Carteirinha do **responsável** |
| --- | --- | --- |
| Quem usa | Qualquer pessoa da lista de autorizados da criança (mãe, pai, avó, tio, vizinha com autorização avulsa) | Só aquela pessoa |
| O que a portaria vê ao ler | Foto e nome da criança e a **lista de quem pode retirar**, com foto e selo ("pode retirar", "não autorizado", "bloqueado"); a vigilante toca em quem está presente | Foto e nome da pessoa e **todos os filhos** dela, já com ENTRADA/SAÍDA sugerida |
| Irmãos | Uma carteirinha por criança (duas leituras) | Uma leitura registra os dois |
| Se perder | Só a criança fica sem carteirinha | Só aquela pessoa fica sem |
| Quantidade | 1 por criança | 1 por responsável que a família quiser |

**Recomendação:** emita a **carteirinha da criança como padrão** — fica na
mochila e funciona com qualquer pessoa autorizada, inclusive quem busca só de
vez em quando. Ofereça a **carteirinha de responsável** como opcional para
quem tem mais de um filho na creche (uma leitura só para os irmãos) ou prefere
levar no chaveiro.

As duas podem coexistir: a mesma criança pode ser identificada pela sua
carteirinha ou pela do responsável, e a portaria sempre pode buscar pelo nome.

## 2. Gerar

Uma de cada vez (entre como administrador):

1. **Crianças** → abra a criança → aba **Carteirinhas** → **Gerar carteirinha**.
   Para responsáveis: **Responsáveis** → a pessoa → **Carteirinhas**.
2. O código é sorteado na hora e aparece na lista com os botões **Imprimir**,
   **Colar NFC**, **Revogar** e **Revogar e gerar nova**.

Em lote (recomendado no início do ano):

1. **Carteirinhas** → **Gerar em lote**.
2. Escolha **Para quem** (Crianças, ou Responsáveis das crianças da turma) e a
   **Turma** (ou todas).
3. Deixe marcado **Só quem ainda não tem carteirinha ativa** — assim quem já
   tem não recebe uma segunda (se desmarcar, todos recebem mais uma; as
   antigas continuam válidas).
4. As carteirinhas criadas já ficam **selecionadas** para impressão.

## 3. Imprimir

1. Em **Carteirinhas**, filtre (turma, dono, "sem etiqueta"…), marque as
   carteirinhas ou use **Selecionar todas**, e toque em **Imprimir
   selecionadas** (ou **Imprimir turma X**). Marque **Imprimir com foto** se
   quiser a foto no cartão (recomendado para carteirinha de responsável;
   dispensável na da criança).
2. A página de impressão monta folhas **A4 com 10 cartões** (2 colunas × 5),
   cada um no tamanho de cartão de crédito (CR80, 85,6 × 54 mm) com:
   primeiro nome e inicial do sobrenome, turma (criança) ou "Responsável",
   nome e telefone da creche, o código em letras grandes, o QR Code com cerca
   de 3 cm e um círculo marcando onde colar a etiqueta NFC.
3. No diálogo de impressão do navegador: papel A4, **escala 100 %** (não
   "ajustar à página"), margens padrão, fundo/gráficos ativados. Confira na
   régua se o cartão impresso mede 85 × 54 mm — o QR precisa ter pelo menos
   3 cm para a câmera ler bem.
4. Papel: cartão 180–250 g/m² (ou papel comum e depois plastificar).
5. Corte pelas linhas tracejadas e **plastifique fosco** (laminação fosca, não
   brilhante: o brilho reflete o sol e atrapalha a leitura do QR na portaria).
   Fure e coloque num cordão ou chaveiro; a da criança pode ir presa na
   mochila.

Dica: imprima duas da criança (mochila e chaveiro do pai/mãe) só se a família
pedir — cada carteirinha a mais é uma a mais para controlar.

## 4. Etiquetas NFC (opcional)

A etiqueta NFC deixa a leitura instantânea: a vigilante encosta a carteirinha
na parte de trás do celular e a tela de confirmação já abre. Sem etiqueta, o
QR Code pela câmera resolve em 1–2 segundos; o ganho da NFC é conforto e
funcionar com luz ruim ou cartão sujo.

### O que comprar

| Tipo | Quando usar | Custo aproximado (2026) |
| --- | --- | --- |
| **Adesivo NTAG213**, redondo 25 mm ou retangular, branco | Colar no cartão de papel plastificado impresso pelo sistema (dentro do círculo, antes ou depois de plastificar — se depois, fica por fora e mais exposto) | R$ 1 a R$ 3 a unidade em lotes de 50–100 |
| **Cartão PVC branco com chip NTAG213** (tamanho de cartão de crédito) | Se preferir um cartão rígido: imprima a arte do sistema numa etiqueta adesiva e cole no PVC, ou use uma impressora de cartões | R$ 3 a R$ 6 a unidade |
| Chaveiro NFC NTAG213 | Para responsáveis que preferem chaveiro (o código/QR fica só no cartão de papel) | R$ 2 a R$ 5 |

Onde comprar: em marketplaces e lojas de eletrônica procure por "NTAG213
adesivo", "tag NFC NTAG213 25mm" ou "cartão NFC NTAG213". Prefira vendedores
com fotos do chip e avaliações; compre 10 % a mais para perdas.

Evite:

- chips **MIFARE Classic** (1K/4K): muitos celulares Android não os leem pelo
  navegador — o sistema usa apenas etiquetas do tipo NDEF (NTAG213/215/216);
- etiquetas "anti-metal" ou muito pequenas (menos de 18 mm): alcance curto;
- etiquetas com **proteção contra gravação já ativada**, se você pretende
  gravar a URL nelas (a leitura do número de série funciona mesmo assim).

NTAG213 (144 bytes) é suficiente: a URL da carteirinha cabe com folga. NTAG215
e 216 também funcionam, só custam mais.

### Colar e vincular pelo app

A vinculação é feita na área da administração, que também abre no celular. Ela
exige **Chrome no Android** com NFC ligado (num computador ou iPhone o botão
avisa que não dá para ler etiquetas). A direção pode fazer isso no próprio
celular da portaria, entrando com a sua conta de administração e saindo em
seguida.

1. Cole a etiqueta no círculo do cartão.
2. No celular Android, abra o app, entre como administrador e vá a
   **Carteirinhas** (ou à aba Carteirinhas da criança/responsável). Localize a
   carteirinha pela busca por nome ou pelo código impresso e toque em
   **Colar NFC**.
3. Na janela **Colar etiqueta NFC**, toque para ativar o leitor se ele pedir
   ("Toque em Ativar leitor") e **encoste a etiqueta na parte de trás do
   celular** (perto da câmera na maioria dos aparelhos). Mantenha parada até
   aparecer "Etiqueta … colada à carteirinha. A portaria já reconhece esta
   etiqueta."
4. Opcional: **Gravar URL na etiqueta**. Grava o endereço
   `https://<domínio>/c/<código>` no chip, para que qualquer celular com NFC
   (mesmo sem o app) abra a página pública da carteirinha — útil quando alguém
   encontra uma perdida. Mantenha a etiqueta encostada.
5. Opcional e **irreversível**: **Proteger contra gravação**. Impede que a
   etiqueta seja regravada com outro conteúdo. Só aparece depois de gravar a
   URL. Recomendado para carteirinhas que vão para a mochila.
6. **Concluir**. Na lista, a carteirinha passa a mostrar o selo "NFC" com o
   número de série; a portaria recebe a atualização automaticamente.

Mensagens que podem aparecer:

| Mensagem | Significado |
| --- | --- |
| "Esta etiqueta já está colada em outra carteirinha ativa. Revogue a outra antes." | Cada etiqueta só pode estar em uma carteirinha ativa. Você pegou uma etiqueta reaproveitada. |
| "Etiqueta sem número de série legível. Use uma etiqueta NTAG213/215/216." | Chip incompatível. |
| "Etiqueta protegida contra gravação ou ilegível." | A etiqueta já está travada (a vinculação por número de série funciona mesmo assim; só a gravação da URL não). |
| "A etiqueta foi afastada antes de terminar." | Encoste de novo e não mexa. |

Você também pode informar o número de série ao gerar a carteirinha pela API
(`nfcUid`), mas na prática o fluxo acima é o mais simples.

## 5. Perdeu a carteirinha

1. **Crianças** (ou Responsáveis) → a pessoa → **Carteirinhas** → **Revogar e
   gerar nova** (uma ação só). A antiga fica marcada "revogada", com data; o
   código **e** a etiqueta NFC dela param de valer ao mesmo tempo.
2. Imprima a nova e, se usar NFC, cole e vincule uma etiqueta nova.
3. O dono recebe o alerta "A carteirinha 7K3P-2Q9M foi cancelada pela
   creche" (para carteirinha de criança, todos os responsáveis recebem). Peça
   para entregar a antiga se ela reaparecer.
4. Se alguém tentar usar a carteirinha revogada, a portaria vê **"Carteirinha
   cancelada — avise a direção"** — mesmo sem internet, porque o celular
   guarda a lista de revogadas dos últimos 90 dias. Se um registro da fila
   offline tiver sido feito com uma carteirinha já revogada, ele é gravado
   como exceção e destacado para a direção.

Se só a etiqueta descolou, mas o cartão está inteiro, não precisa revogar:
cole outra etiqueta e vincule-a (a nova substitui a anterior na mesma
carteirinha).

## 6. Por que a etiqueta não é segredo

O número de série da etiqueta pode ser lido por qualquer celular, o código
está impresso e o QR pode ser fotografado. **Nada disso é tratado como senha.**
A segurança do sistema vem de outro lugar:

1. **A foto na tela.** Ao ler a carteirinha, a vigilante vê a foto de quem
   pode retirar e compara com a pessoa à sua frente. Sem foto cadastrada, a
   tela exige "Documento conferido".
2. **A lista de autorizados.** Só quem está no vínculo com "pode retirar" (e
   dentro da validade), ou tem autorização avulsa para hoje, sai sem exceção.
   Pessoa bloqueada é recusada mesmo com carteirinha.
3. **O alerta a todos os responsáveis.** Toda saída avisa mãe, pai e demais
   responsáveis na hora, dizendo quem retirou. Uma retirada indevida não
   passa despercebida.
4. **Registro de recusas e exceções.** Tentativas recusadas, saídas fora da
   lista e conflitos ficam gravados e vão para a direção.

Por isso a página pública `/c/<código>` mostra só o nome e o telefone da creche
("Se você encontrou esta carteirinha, ligue…"), nunca dados da criança, e a
carteirinha impressa traz apenas o primeiro nome e a turma.

## 7. Checklist do início do ano

- [ ] Fotos de todas as crianças e responsáveis atualizadas (a portaria confere por elas).
- [ ] Carteirinhas geradas em lote por turma; impressas com escala 100 %; plastificadas fosco.
- [ ] Etiquetas NFC coladas e vinculadas (selo "NFC" na lista), se a creche usa NFC.
- [ ] Um responsável de cada família testou a carteirinha na portaria.
- [ ] Todos sabem: perdeu = avisar a secretaria no mesmo dia para revogar.
