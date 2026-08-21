# Carnaval do Fogo e Paixão — Guia de configuração e deploy

Este site é feito só com HTML, CSS e JavaScript puro (sem build, sem npm, sem framework), usando o **Firebase** como backend (login e banco de dados) e o **Netlify** para hospedar. Não é preciso instalar nada no computador — tudo é feito pelo navegador.

Tempo estimado: 30–45 minutos, feito uma única vez.

## Antes de começar

Você vai precisar de:
- Uma conta Google (para o Firebase).
- Uma conta no [GitHub](https://github.com) (para guardar o código).
- Uma conta no [Netlify](https://netlify.com) (para publicar o site — pode entrar direto com a conta do GitHub).

---

## Parte 1 — Criar o projeto no Firebase

1. Acesse [console.firebase.google.com](https://console.firebase.google.com) e clique em **"Adicionar projeto"**.
2. Dê um nome, por exemplo `carnaval-fogo-e-paixao`. Pode desativar o Google Analytics (não é necessário).
3. Aguarde o projeto ser criado e clique em **"Continuar"**.

### 1.1 — Ativar o login por e-mail e senha

1. No menu lateral, vá em **Build → Authentication**.
2. Clique em **"Get started"** (ou "Vamos lá").
3. Na aba **Sign-in method**, clique em **"Email/Password"**.
4. Ative a primeira opção ("Email/Password") e clique em **Salvar**.

O cadastro não exige confirmação por e-mail — assim que a pessoa cria o login e preenche os dados, já entra direto na área do batuqueiro.

> Dica opcional: em **Authentication → Templates**, você pode personalizar o texto do e-mail de redefinição de senha (trocar para português, adicionar o nome da bateria, etc.).

### 1.2 — Criar o banco de dados (Firestore)

1. No menu lateral, vá em **Build → Firestore Database**.
2. Clique em **"Criar banco de dados"**.
3. Escolha a região mais próxima do Brasil, por exemplo `southamerica-east1 (São Paulo)`.
4. Escolha o modo **"Produção"** (production mode). Não use o modo de teste — as regras corretas serão publicadas no próximo passo.

### 1.3 — Publicar as regras de segurança

O arquivo `firestore.rules` (incluído neste pacote) já contém as regras corretas: qualquer pessoa logada pode ver a lista de batuqueiros e a presença de todos, mas só quem tem permissão marca presença; só o dono de um cadastro (ou um admin) pode editá-lo; e só admins mexem em edições, posições, ensaios, músicas, preços ou concedem acessos. Uma edição encerrada fica travada até para o admin.

> **Sempre que este arquivo mudar numa atualização do site, republique as regras.** É um passo separado de subir o código no GitHub — se esquecer, o site publica normalmente mas algumas ações passam a dar erro de permissão.

1. No Firestore, vá na aba **"Regras"** (Rules).
2. Apague o conteúdo que estiver lá.
3. Abra o arquivo `firestore.rules` deste pacote, copie todo o conteúdo e cole no editor do Firebase.
4. Clique em **"Publicar"**.

### 1.4 — Criar o app Web e pegar as chaves de configuração

1. Na página inicial do projeto (ícone de engrenagem ⚙️ → **"Configurações do projeto"**), role até **"Seus apps"**.
2. Clique no ícone `</>` (Web).
3. Dê um apelido, por exemplo `site-carnaval`, e clique em **"Registrar app"**. Não é necessário marcar a opção de Firebase Hosting.
4. O Firebase vai mostrar um bloco de código com `const firebaseConfig = { apiKey: "...", ... }`. Copie esses valores.
5. Abra o arquivo `firebase-init.js` deste pacote e substitua os valores de exemplo:

```js
const firebaseConfig = {
  apiKey: "COLE_AQUI_SUA_apiKey",
  authDomain: "COLE_AQUI_SEU_authDomain",
  projectId: "COLE_AQUI_SEU_projectId",
  storageBucket: "COLE_AQUI_SEU_storageBucket",
  messagingSenderId: "COLE_AQUI_SEU_messagingSenderId",
  appId: "COLE_AQUI_SEU_appId",
};
```

pelos valores reais copiados do Firebase. Salve o arquivo. (Essas chaves não são secretas — elas identificam o projeto, não dão acesso a nada por si só; quem protege os dados são as regras do Firestore que você publicou no passo 1.3.)

---

## Parte 2 — Colocar o código no GitHub

1. Crie um repositório novo em [github.com/new](https://github.com/new) — por exemplo `carnaval-fogo-e-paixao`. Pode ser privado ou público.
2. Suba todos os arquivos desta pasta (`index.html`, `app.js`, `styles.css`, `firebase-init.js`, `firestore.rules`, e opcionalmente `test.html` e `firebase-init.mock.js`) para o repositório. O jeito mais simples é pela própria interface do GitHub: **"Add file" → "Upload files"**, arrastar todos os arquivos, e clicar em **"Commit changes"**.

---

## Parte 3 — Publicar no Netlify

1. Acesse [app.netlify.com](https://app.netlify.com) e entre com sua conta.
2. Clique em **"Add new site" → "Import an existing project"**.
3. Escolha **GitHub** e autorize o acesso; selecione o repositório que você criou.
4. Nas configurações de build:
   - **Build command:** deixe em branco (não há build).
   - **Publish directory:** deixe em branco ou `.` (a raiz do repositório).
5. Clique em **"Deploy site"**.

Em cerca de 1 minuto o Netlify gera um endereço tipo `https://algum-nome-aleatorio.netlify.app`. Esse já é o site funcionando. Se quiser, em **"Site settings" → "Change site name"** dá para trocar por um nome mais bonito (ex: `carnaval-fogo-e-paixao.netlify.app`), ou conectar um domínio próprio em **"Domain settings"**.

Qualquer alteração futura no código: basta subir os arquivos atualizados no GitHub, e o Netlify publica a nova versão automaticamente.

---

## Parte 4 — Virar o primeiro administrador (passo manual, uma única vez)

Por segurança, ninguém consegue se autopromover a admin pelo próprio site — nem no cadastro, nem depois (as regras do Firestore impedem isso de propósito). Por isso, a primeira pessoa admin precisa ser configurada manualmente, direto no Firebase, uma única vez:

1. Acesse o site publicado e crie seu cadastro normalmente (**"Criar meu cadastro"**), como qualquer batuqueiro faria.
2. No **Firebase Console → Firestore Database → Dados**, abra a coleção `pessoas`.
3. Encontre o documento com o seu e-mail (o ID do documento é o seu UID, mas o campo `email` mostra qual é o seu).
4. Clique no campo `adminAccess`, que estará como `false`, e mude para `true`.
5. Volte ao site e atualize a página — o botão **"Painel admin"** já vai aparecer no seu cabeçalho.

A partir daí, você (como admin) pode conceder acesso admin a outras pessoas diretamente pelo painel (**Cadastros → Editar → "Acesso ao painel admin"**), sem precisar mexer no Firebase Console de novo.

---

## Parte 5 — Criar a primeira edição do carnaval

O site guarda um carnaval por **edição** (2027, 2028, ...). Cada edição tem as próprias posições, ensaios, músicas, valores de anuidade, inscrições e presenças — é isso que permite acumular um histórico ano após ano sem misturar os dados de um carnaval com os do outro. Os dados permanentes de cada pessoa (nome, sobrenome, celular, data de nascimento) ficam fora das edições e nunca precisam ser redigitados.

No painel admin, vá em **"Gerenciar edições" → "Criar nova edição"**:

1. Informe o ano, o nome (ex: "Carnaval do Fogo e Paixão 2027") e a data do desfile.
2. Se já existir uma edição anterior, deixe marcado **"Copiar posições e valores de anuidade"** — você começa com tudo pronto e só ajusta o que mudou.
3. A edição nasce **"Em preparação"**: só você a enxerga. Aproveite para conferir posições, valores, prazos e já cadastrar as datas de ensaio com calma.
4. Quando estiver tudo certo, clique em **"Abrir para os batuqueiros"**. A partir daí eles passam a ver e preencher os dados dessa edição.

Na primeira edição, quando ela ainda não tem nada, aparece a caixa **"Primeiro acesso desta edição"** com um botão que carrega as 17 posições/instrumentos e os valores de anuidade padrão de uma vez — evita cadastrar tudo à mão.

### O ciclo de vida de uma edição

| Situação | O que significa |
|---|---|
| **Em preparação** | Só o admin vê. Serve para montar tudo antes de liberar. |
| **Aberta** | Em andamento. Os batuqueiros se inscrevem, pagam e marcam presença. Só uma edição fica aberta por vez — ao abrir uma nova, a anterior é encerrada automaticamente. |
| **Encerrada** | Virou histórico. Ninguém edita mais nada nela, nem o admin. Continua visível para consulta. |

Se precisar corrigir algo depois do carnaval, use **"Reabrir"** na tela de edições: ela volta para "Em preparação" (visível só para você), você corrige, e abre de novo se for o caso.

### O que acontece com os batuqueiros a cada novo carnaval

Quando você abre uma edição nova, quem já tem cadastro entra no site e vê uma tela de **"Confirmar inscrição"**, já preenchida com os dados do último carnaval em que a pessoa participou (posição, camisa, se vai tocar). Ela só confere, ajusta o que mudou e confirma. Nome e data de nascimento não são pedidos de novo.

Cada pessoa também passa a ter um **"Meu histórico de carnavais"**, com a posição de cada ano, a situação da anuidade e quantos ensaios frequentou.

---

## Parte 6 — Importar dados de antes (só se o site já estava em uso)

Se você já estava usando o site antes da separação por edições, os dados antigos precisam ser reorganizados uma única vez. É um botão, feito por você mesmo pelo site.

> **Você continua sendo admin durante a transição.** O acesso de organizador que estava em `users` é reconhecido normalmente pelo site novo até a importação acontecer — não é preciso mexer no Firebase Console de novo. Ao entrar, você vê direto um aviso com o botão de importar; se você tiver refeito o cadastro por engano nesse meio-tempo, a importação corrige o registro duplicado sozinha, trazendo de volta seus dados originais.

1. Entre no site como admin.
2. Vá em **Painel admin → "Gerenciar edições" → "Importar agora"** (ou, se ainda não houver nenhuma edição, no botão **"Importar dados do formato antigo"** que aparece direto no painel).
3. O site pergunta de que ano são aqueles dados. Informe (ex: 2027).
4. Pronto: os cadastros, posições, ensaios, músicas, valores e presenças que existiam passam a viver dentro dessa edição, já separando o que é permanente do que é daquele carnaval. A edição nasce **aberta**, então nada muda na prática para quem já estava usando.

Os comprovantes de pagamento de cada pessoa são levados automaticamente na primeira vez que ela entrar no site depois da importação — isso porque as regras de segurança só deixam cada um ler os próprios comprovantes (nem o admin vê os dos outros). O total já pago vai junto na importação, então nenhum saldo fica errado nesse meio-tempo.

Depois de conferir que está tudo certo, as coleções antigas (`users`, `posicoes`, `ensaios`, `musicas`, `config`, `presencas`, `pagamentos` na raiz) podem ser apagadas no Firebase Console, junto com o bloco correspondente no final do `firestore.rules`.

---

## Testando antes de divulgar o link (opcional, recomendado)

Este pacote inclui `test.html`, uma versão do site que usa um Firebase "simulado" (`firebase-init.mock.js`) — tudo acontece só na memória do navegador, nada é enviado para a internet nem para o Firebase real. É útil para você mesmo clicar em tudo e conferir os fluxos (cadastro, pagamento, presença, painel admin) sem misturar dados de teste com os dados reais da bateria.

Para usar: abra `test.html` num navegador (pode ser localmente ou publicando também esse arquivo). O rótulo preto no topo ("MODO TESTE") deixa claro que não é o site de verdade.

Se você tiver o Node.js instalado, também há um script de teste automatizado (`run-tests.mjs`) que exercita o site inteiro — cadastro, login, ciclo de vida das edições (criar, preparar, abrir, encerrar, reabrir), renovação de inscrição de um ano para o outro, pagamentos, presença, histórico, isolamento entre edições e a importação dos dados antigos — e imprime um relatório de sucesso/falha. É uma ferramenta de desenvolvedor, opcional, não necessária para o dia a dia.

---

## Perguntas frequentes

**Isso vai custar alguma coisa?** Para o tamanho de uma bateria (algumas dezenas a poucas centenas de pessoas), tanto o Firebase (plano gratuito "Spark") quanto o Netlify (plano gratuito) são mais do que suficientes. O Firebase Spark inclui, por mês, um volume generoso de leituras/escritas no Firestore e de logins — muito acima do que esse uso gera.

**Uma pessoa pode ver os pagamentos de outra?** Não. Cada pessoa só vê os detalhes (pix, data, valor) dos próprios pagamentos. O admin vê o total pago de cada pessoa (para o relatório geral), mas não os comprovantes individuais de quem não é ele mesmo.

**Quem pode marcar presença nos ensaios?** Só admins e quem recebeu esse acesso individualmente. Todo mundo vê a tabela de presença de todos os ensaios (como uma "lista de chamada" coletiva, só para consulta), mas só marca SIM/NÃO quem tiver permissão. Para dar esse acesso a alguém que não é admin: painel admin → Cadastros → editar a pessoa → marcar "Pode marcar presença nos ensaios (de qualquer batuqueiro) sem ser admin".

**E se eu esquecer minha senha?** Na tela de login há um link "Esqueci minha senha", que envia um e-mail de redefinição pelo próprio Firebase.

**Como adiciono mais um organizador?** Painel admin → Cadastros → editar a pessoa → marcar "Acesso ao painel admin". Ela continua aparecendo normalmente nas listas de presença e pagamento, só ganha também a visão de admin.

**Como registro quais músicas foram ensaiadas?** Painel admin → "Repertório / músicas" cadastra o repertório (nome, tom e cantor(a) de cada música, em ordem alfabética). Depois, em Painel admin → Ensaios, cada data tem um botão "Editar músicas" onde você marca quais músicas dessa lista foram tocadas naquele ensaio. Tanto o repertório quanto as marcações valem só para a edição em que foram feitos.

**O que exatamente é guardado por carnaval e o que é permanente?** Permanente (vale para sempre, em `/pessoas`): nome, sobrenome, e-mail, celular, data de nascimento, acesso ao painel admin e acesso para marcar presença. Por carnaval (dentro de `/edicoes/{id}`): posição/instrumento, tamanho da camisa, se vai tocar, isenção individual, forma de pagamento e valor pago, além das posições disponíveis, ensaios, repertório, valores da anuidade e presenças daquele ano.

**Posso ver os dados de um carnaval antigo?** Sim. No painel admin, o seletor **"Estou vendo os dados de"** troca a edição que está sendo exibida — todas as telas (ensaios, posições, músicas, relatório, cadastros) passam a mostrar aquele carnaval. Se a edição estiver encerrada, tudo fica só leitura, com um aviso no topo. Cada batuqueiro também tem o próprio "Meu histórico de carnavais".

**E se eu quiser comparar todos os carnavais de uma vez?** Painel admin → **"Histórico geral"**. São duas tabelas com uma coluna por carnaval:

- **Batuqueiros por carnaval** — todo mundo que já teve cadastro no site, tenha participado de um carnaval ou de todos. Cada célula mostra a posição da pessoa naquele ano (verde) quando ela tocou, "Não tocou" (amarelo) quando ela se inscreveu mas avisou que não ia tocar, e um traço quando ela não teve inscrição naquele carnaval. A última coluna conta em quantos carnavais a pessoa tocou.
- **Músicas por carnaval** — todo o repertório já cadastrado, em qualquer ano. Cada célula mostra em quantos ensaios daquele carnaval a música foi tocada (verde), "No repertório" (amarelo) quando ela foi cadastrada mas nunca ensaiada, e um traço quando não fazia parte do repertório daquele ano. A mesma música é reconhecida de um ano para o outro pelo nome.

O campo de busca no topo filtra as duas tabelas ao mesmo tempo, e os totais do rodapé acompanham o filtro. Como essa tela lê todos os carnavais de uma vez, ela é carregada sob demanda — se você acabou de mudar alguma coisa em outra tela, use o botão "Atualizar".

**Por que o identificador da edição é `2027-1` e não a data do desfile?** No Firestore, o identificador de um registro não pode ser alterado depois de criado — só copiando tudo para outro e apagando o original. Como a data do desfile costuma mudar depois de cadastrada, usá-la como identificador deixaria o nome permanentemente errado. O ano não muda, e o `-1`, `-2` cobre o caso de desfilar duas vezes no mesmo ano. A data do desfile fica num campo próprio, que você edita quando quiser — e é ela que aparece em todas as telas.

**Alguém pode se inscrever num carnaval que já passou?** Não. Só é possível se inscrever na edição que estiver aberta. Quem não participou de uma edição encerrada simplesmente não aparece nas listas daquele ano — e quem participou fica registrado ali para sempre, mesmo que saia da bateria depois.

**Tirei alguém da edição por engano. Perdi o cadastro dela?** Não. "Tirar da edição" remove só a inscrição naquele carnaval; o cadastro da pessoa e o histórico dela em outros anos continuam intactos. Ela aparece na seção "Cadastrados sem inscrição nesta edição" e pode se inscrever de novo entrando no site.

**Por que o campo de calendário pode mostrar mm/dd/aaaa em vez de dd/mm/aaaa?** Todo texto de data que o próprio site escreve (datas de nascimento, prazos de parcela, data de pagamento, data de ensaio) está sempre em dd/mm/aaaa. Só o "calendário" clicável (o ícone 📅 dentro do campo, ao editar) é um componente do navegador da pessoa, não do site — a grande maioria dos navegadores em português já mostra esse seletor em dd/mm/aaaa, mas em algum navegador configurado em outro idioma ele pode aparecer diferente. Isso não afeta o valor salvo, só a aparência do seletor.
