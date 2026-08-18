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

A confirmação por e-mail (link de verificação) já é enviada automaticamente pelo próprio código do site (`sendEmailVerification`) — não precisa configurar nada extra aqui, além do provedor "Email/Password" acima estar ativo.

> Dica opcional: em **Authentication → Templates**, você pode personalizar o texto do e-mail de verificação e de redefinição de senha (trocar para português, adicionar o nome da bateria, etc.).

### 1.2 — Criar o banco de dados (Firestore)

1. No menu lateral, vá em **Build → Firestore Database**.
2. Clique em **"Criar banco de dados"**.
3. Escolha a região mais próxima do Brasil, por exemplo `southamerica-east1 (São Paulo)`.
4. Escolha o modo **"Produção"** (production mode). Não use o modo de teste — as regras corretas serão publicadas no próximo passo.

### 1.3 — Publicar as regras de segurança

O arquivo `firestore.rules` (incluído neste pacote) já contém as regras corretas: qualquer pessoa logada pode ver a lista de batuqueiros e marcar presença, mas só o dono de um cadastro (ou um admin) pode editá-lo, e só admins podem mexer em posições, ensaios, preços ou conceder acesso ao painel admin.

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
2. Confirme seu e-mail (clique no link recebido).
3. No **Firebase Console → Firestore Database → Dados**, abra a coleção `users`.
4. Encontre o documento com o seu e-mail (o ID do documento é o seu UID, mas o campo `email` mostra qual é o seu).
5. Clique no campo `adminAccess`, que estará como `false`, e mude para `true`.
6. Volte ao site e atualize a página — o botão **"Painel admin"** já vai aparecer no seu cabeçalho.

A partir daí, você (como admin) pode conceder acesso admin a outras pessoas diretamente pelo painel (**Cadastros → Editar → "Acesso ao painel admin"**), sem precisar mexer no Firebase Console de novo.

Assim que entrar no painel admin pela primeira vez, vai aparecer uma caixa **"Primeiro acesso"** com um botão para carregar as posições/instrumentos e os valores de anuidade padrão — isso evita ter que cadastrar as 17 posições uma por uma. Depois é só ajustar o que quiser (valores, prazos, isenções) nas telas de edição.

---

## Testando antes de divulgar o link (opcional, recomendado)

Este pacote inclui `test.html`, uma versão do site que usa um Firebase "simulado" (`firebase-init.mock.js`) — tudo acontece só na memória do navegador, nada é enviado para a internet nem para o Firebase real. É útil para você mesmo clicar em tudo e conferir os fluxos (cadastro, pagamento, presença, painel admin) sem misturar dados de teste com os dados reais da bateria.

Para usar: abra `test.html` num navegador (pode ser localmente ou publicando também esse arquivo). O rótulo preto no topo ("MODO TESTE") deixa claro que não é o site de verdade. Como o e-mail de verificação não pode ser realmente enviado nesse modo, digite `window.__mock.verifyEmail("seuemail@teste.com")` no console do navegador (F12) para simular a confirmação.

Se você tiver o Node.js instalado, também há um script de teste automatizado (`run-tests.mjs`) que exercita o site inteiro (cadastro, login, pagamentos, presença marcada por outra pessoa, todas as telas do admin) e imprime um relatório de sucesso/falha — mas isso é uma ferramenta de desenvolvedor, opcional, não necessária para o dia a dia.

---

## Perguntas frequentes

**Isso vai custar alguma coisa?** Para o tamanho de uma bateria (algumas dezenas a poucas centenas de pessoas), tanto o Firebase (plano gratuito "Spark") quanto o Netlify (plano gratuito) são mais do que suficientes. O Firebase Spark inclui, por mês, um volume generoso de leituras/escritas no Firestore e de logins — muito acima do que esse uso gera.

**Uma pessoa pode ver os pagamentos de outra?** Não. Cada pessoa só vê os detalhes (pix, data, valor) dos próprios pagamentos. O admin vê o total pago de cada pessoa (para o relatório geral), mas não os comprovantes individuais de quem não é ele mesmo.

**Qualquer pessoa logada pode mesmo marcar presença de qualquer outra?** Sim, esse foi um pedido explícito — a tabela de presença funciona como uma "lista de chamada" coletiva, qualquer batuqueiro pode marcar SIM/NÃO para si e para os colegas.

**E se eu esquecer minha senha?** Na tela de login há um link "Esqueci minha senha", que envia um e-mail de redefinição pelo próprio Firebase.

**Como adiciono mais um organizador?** Painel admin → Cadastros → editar a pessoa → marcar "Acesso ao painel admin". Ela continua aparecendo normalmente nas listas de presença e pagamento, só ganha também a visão de admin.
