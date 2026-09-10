# LGPD — orientações e modelo de termo de consentimento

O sistema trata dados pessoais de crianças e de seus responsáveis. A Lei Geral
de Proteção de Dados (Lei nº 13.709/2018) exige cuidado extra com dados de
crianças (art. 14): o tratamento deve ser feito no melhor interesse da criança
e, quando baseado em consentimento, este deve ser específico e dado por pelo
menos um dos pais ou responsável legal.

## O que o sistema guarda

| Dado | De quem | Para quê | Onde |
| --- | --- | --- | --- |
| Nome, data de nascimento, turma, foto | criança | identificar a criança na portaria e nos alertas | banco SQLite + pasta de fotos no servidor da creche |
| Nome, e-mail, telefone, foto, parentesco | responsável | identificar quem deixa/retira; enviar alertas | idem |
| Horário de entrada e saída, quem deixou/retirou, quem registrou | criança / responsável / vigilante | segurança e comprovação | idem |
| Inscrição de notificação push | responsável | enviar alertas ao celular | idem |

Não há rastreadores, analytics ou envio de dados a terceiros, exceto:
o provedor de e-mail (SMTP) configurado pela creche e o serviço de push do
navegador (Google/Apple/Mozilla), que recebe apenas o texto do alerta.

## Boas práticas para a creche

1. **Base legal**: colher o termo abaixo assinado (papel ou digital) de um dos
   pais/responsável legal antes de cadastrar a criança.
2. **Mínimo necessário**: não cadastre CPF, endereço ou dados de saúde no
   campo de observações a menos que seja indispensável.
3. **Acesso**: só a direção/secretaria tem acesso ao painel; a vigilante vê
   apenas nome, foto, parentesco e autorização.
4. **Retenção**: manter os registros de entrada/saída por no máximo 24 meses
   após o desligamento da criança; depois, excluir (o painel oferece
   "Desativar" e a exclusão definitiva pode ser feita pela direção).
5. **Segurança**: HTTPS obrigatório, senhas fortes, celular da portaria com
   bloqueio de tela, backup do diretório `data/` guardado em local seguro.
6. **Incidentes**: em caso de vazamento, comunicar a ANPD e os responsáveis
   conforme o art. 48.
7. **Direitos do titular**: o responsável pode pedir acesso, correção e
   exclusão dos dados pela secretaria.

## Modelo de termo de consentimento

> **TERMO DE CONSENTIMENTO PARA TRATAMENTO DE DADOS PESSOAIS**
> **Creche:** ______________________________________
>
> Eu, ______________________________________, portador(a) do documento
> nº ______________, na condição de ☐ mãe ☐ pai ☐ responsável legal da
> criança ______________________________________, nascida em ___/___/______,
> autorizo a creche acima a coletar e tratar os seguintes dados para fins de
> **controle de entrada e saída da criança e envio de alertas de segurança
> aos responsáveis**:
>
> - da criança: nome, data de nascimento, turma e fotografia;
> - dos responsáveis autorizados: nome, e-mail, telefone, fotografia e grau
>   de parentesco;
> - registros de horário de entrada e saída, com identificação de quem
>   deixou e quem retirou a criança.
>
> Estou ciente de que: (i) os dados ficam armazenados em servidor sob
> responsabilidade da creche; (ii) posso solicitar acesso, correção ou
> exclusão dos dados a qualquer momento junto à secretaria; (iii) os dados
> serão mantidos enquanto a criança estiver matriculada e por até 24 meses
> após o desligamento; (iv) as pessoas que indicarei como autorizadas a
> retirar a criança serão informadas deste tratamento.
>
> Pessoas autorizadas a retirar a criança:
> 1. Nome: __________________ Parentesco: ________ Tel.: ____________
> 2. Nome: __________________ Parentesco: ________ Tel.: ____________
> 3. Nome: __________________ Parentesco: ________ Tel.: ____________
>
> Local e data: ____________________, ___/___/______
>
> Assinatura: ______________________________________
