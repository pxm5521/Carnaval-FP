// Teste automatizado (Playwright) rodando contra test.html + firebase-init.mock.js.
//
// Cobre o ciclo completo do site na estrutura multi-carnaval:
// - cadastro em 2 etapas, login/logout, "esqueci minha senha" (link presente)
// - ciclo de vida de uma edição: criar → preparar → abrir → encerrar → reabrir
// - inscrição por edição, com pré-preenchimento a partir do carnaval anterior
// - dados permanentes (nome/nascimento) separados dos dados do ano (posição,
//   camisa, vai tocar, isenção, pagamento)
// - posições, preços, ensaios, repertório e músicas ensaiadas, tudo por edição
// - presença: leitura para todos, edição só para admin ou quem recebeu acesso
// - histórico do batuqueiro com vários carnavais
// - isolamento entre edições (dados de um ano não vazam para o outro)
// - importação única dos dados do formato antigo
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = 'http://localhost:8934/test.html';
let pass = 0, fail = 0;
const failures = [];

function ok(desc, cond) {
  if (cond) { pass++; console.log(`  OK    ${desc}`); }
  else { fail++; failures.push(desc); console.log(`  FAIL  ${desc}`); }
}

async function appHtml(page) {
  return page.evaluate(() => document.getElementById('app').innerHTML);
}

// Data de nascimento é composta por 3 campos separados (Dia / Mês / Ano) em vez de
// um <input type="date"> nativo — evita o bug de troca dia/mês que o navegador
// pode causar conforme o idioma do sistema. iso no formato "aaaa-mm-dd".
async function fillDataEmTresCampos(page, idPrefix, iso) {
  const [ano, mes, dia] = iso.split('-');
  await page.selectOption(`#${idPrefix}-dia`, dia);
  await page.selectOption(`#${idPrefix}-mes`, mes);
  await page.fill(`#${idPrefix}-ano`, ano);
}

/* Cadastro completo. O passo 2 pede só os dados permanentes; havendo carnaval
   aberto, vem em seguida o passo 3, a inscrição naquele carnaval. */
async function registrar(page, { email, nome, sobrenome, apelido, posicao, posicaoOutro, camisa, dataNascimento = '1996-05-10', celular = '(21) 90000-0000', comEdicaoAberta = true }) {
  await page.click('#btn-goto-register');
  await page.waitForSelector('#form-register1');
  await page.fill('#reg-email', email);
  await page.fill('#reg-senha', 'senha123');
  await page.fill('#reg-senha2', 'senha123');
  await page.click('#form-register1 button[type=submit]');
  await page.waitForSelector('#form-register2', { timeout: 5000 });
  await page.fill('#c-nome', nome);
  await page.fill('#c-sobrenome', sobrenome);
  if (apelido) await page.fill('#c-apelido', apelido);
  await page.fill('#c-celular', celular);
  await fillDataEmTresCampos(page, 'c-datanasc', dataNascimento);
  await page.click('#form-register2 button[type=submit]');
  await page.waitForSelector('#btn-logout', { timeout: 5000 });
  if (comEdicaoAberta) {
    await confirmarInscricao(page, { vaiTocar: 'Sim', posicao, posicaoOutro, camisa });
  }
}

/* Confirma a inscrição na edição aberta (tela que aparece a cada novo carnaval). */
async function confirmarInscricao(page, { vaiTocar = 'Sim', posicao, posicaoOutro, camisa }) {
  await page.waitForSelector('#form-inscricao', { timeout: 5000 });
  await page.click(`#insc-radio-vaitocar .radio-pill[data-val="${vaiTocar}"]`);
  if (posicao) {
    await page.selectOption('#insc-posicao', posicao);
    if (posicao === 'Outro' && posicaoOutro) await page.fill('#insc-posicao-outro', posicaoOutro);
  }
  if (camisa) await page.click(`#insc-radio-camisa .radio-pill[data-val="${camisa}"]`);
  await page.click('#form-inscricao button[type=submit]');
  await page.waitForTimeout(300);
}

async function login(page, email, senha = 'senha123') {
  await page.waitForSelector('#btn-goto-login', { timeout: 5000 });
  await page.click('#btn-goto-login');
  await page.waitForSelector('#form-login');
  await page.fill('#log-email', email);
  await page.fill('#log-senha', senha);
  await page.click('#form-login button[type=submit]');
  await page.waitForSelector('#btn-logout', { timeout: 5000 });
}

async function logout(page) {
  await page.waitForSelector('#btn-logout', { timeout: 5000 });
  await page.click('#btn-logout');
  await page.waitForSelector('#btn-goto-login', { timeout: 5000 });
}

async function main() {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', msg => { if (msg.type() === 'error') console.log('  [console:error]', msg.text()); });
  page.on('pageerror', err => console.log('  [pageerror]', err.message));

  // Confirmações (confirm) são aceitas; para prompt, respondemos com respostaPrompt.
  let respostaPrompt = '';
  page.on('dialog', async d => {
    if (d.type() === 'prompt') await d.accept(respostaPrompt);
    else await d.accept();
  });

  await page.goto(BASE);
  await page.waitForSelector('#btn-goto-register');

  // ============================================================
  console.log('\n== 1. Cadastro do organizador (Bruno) antes de existir qualquer edição ==');
  await registrar(page, { email: 'bruno@example.com', nome: 'Bruno', sobrenome: 'Costa', comEdicaoAberta: false });
  let html = await appHtml(page);
  ok('Sem edição aberta, o cadastro é aceito e avisa que as inscrições estão fechadas', html.includes('Inscrições fechadas no momento'));
  ok('Nome do cadastro permanente aparece no cabeçalho', html.includes('Bem-vindo(a), Bruno'));
  // Site novo sem nenhum organizador: quem instalou precisa saber como se tornar
  // admin, senão fica sem saída (ninguém pode criar a primeira edição).
  ok('Site sem admin nenhum explica o passo único do Firebase Console', html.includes('É você quem organiza a bateria?'));
  await logout(page);

  console.log('\n== 1b. Erro de login não apaga o e-mail nem fica preso na tela ==');
  await page.click('#btn-goto-login');
  await page.waitForSelector('#form-login');
  await page.fill('#log-email', 'bruno@example.com');
  await page.fill('#log-senha', 'senha-errada');
  await page.click('#form-login button[type=submit]');
  await page.waitForTimeout(400);
  ok('A mensagem de erro aparece', (await appHtml(page)).includes('E-mail ou senha incorretos'));
  ok('O e-mail digitado continua no campo depois do erro', (await page.locator('#log-email').inputValue()) === 'bruno@example.com');
  // "Esqueci minha senha" lê o campo de e-mail: se ele fosse apagado, a
  // recuperação de senha ficava inacessível logo depois de errar a senha.
  ok('O link de recuperar senha ainda enxerga o e-mail', (await page.locator('#log-email').inputValue()).length > 0);
  await page.click('#back-to-landing2');
  await page.waitForTimeout(200);
  await page.click('#btn-goto-login');
  await page.waitForTimeout(200);
  ok('Ao voltar para o login, o erro antigo não está mais lá', !(await appHtml(page)).includes('E-mail ou senha incorretos'));
  await page.click('#back-to-landing2');
  await page.waitForSelector('#btn-goto-login');

  console.log('\n== 2. Bootstrap do primeiro admin (passo único documentado no SETUP.md) ==');
  await page.evaluate(() => window.__mock.grantAdminAccessByEmail('bruno@example.com'));
  await login(page, 'bruno@example.com');
  html = await appHtml(page);
  ok('Bruno agora vê o botão "Painel admin"', html.includes('Painel admin'));
  await page.click('#btn-goto-admin');
  await page.waitForTimeout(150);
  html = await appHtml(page);
  ok('Painel admin avisa que ainda não há nenhuma edição cadastrada', html.includes('Nenhuma edição do carnaval cadastrada ainda'));

  console.log('\n== 3. Criar a primeira edição (2027) ==');
  await page.click('#btn-goto-edicoes');
  await page.waitForTimeout(150);
  await page.click('#btn-toggle-nova-edicao');
  await page.waitForTimeout(150);
  await page.fill('#nova-edicao-ano', '2027');
  await page.fill('#nova-edicao-nome', 'Carnaval do Fogo e Paixão 2027');
  await fillDataEmTresCampos(page, 'nova-edicao-data', '2027-02-09');
  // Regressão: o formulário de nova edição também não pode perder o que foi
  // digitado se a tela for redesenhada antes de salvar.
  await page.evaluate(async () => {
    const fb = await import('./firebase-init.mock.js');
    const ref = await fb.addDoc(fb.collection(fb.db, 'pessoas'), { nome: 'zz', sobrenome: 'temp', adminAccess: false });
    await fb.deleteDoc(fb.doc(fb.db, 'pessoas', ref.id));
  });
  await page.waitForTimeout(250);
  ok('Nome digitado da nova edição sobrevive a um re-render em segundo plano', (await page.locator('#nova-edicao-nome').inputValue()) === 'Carnaval do Fogo e Paixão 2027');
  ok('Ano digitado da nova edição também sobrevive', (await page.locator('#nova-edicao-ano').inputValue()) === '2027');
  ok('Data do desfile escolhida também sobrevive (dia)', (await page.locator('#nova-edicao-data-dia').inputValue()) === '09');
  ok('Data do desfile escolhida também sobrevive (mês)', (await page.locator('#nova-edicao-data-mes').inputValue()) === '02');

  await page.click('#btn-criar-edicao');
  await page.waitForTimeout(400);
  html = await appHtml(page);
  ok('Edição criada com o id ano-sequência (2027-1)', html.includes('(2027-1)'));
  ok('Nasce "Em preparação" (invisível para os batuqueiros)', html.includes('Em preparação'));
  ok('Data do desfile guardada em campo próprio, editável', html.includes('value="2027-02-09"'));

  await page.click('#btn-back-admin7');
  await page.waitForTimeout(200);

  console.log('\n== 3b. O aviso flutuante não apaga o que está sendo digitado ==');
  // Regressão: o aviso ("toast") sumia depois de 3,5s redesenhando a tela inteira,
  // o que limpava qualquer formulário em preenchimento naquele momento — inclusive
  // a tela de login. Agora ele vive fora da área redesenhada.
  await page.click('#btn-goto-edicoes');
  await page.waitForTimeout(200);
  await page.click('[data-save-edicao="2027-1"]');   // dispara um aviso
  await page.waitForTimeout(200);
  ok('O aviso aparece', await page.locator('#toast-host:visible').count() === 1);
  await page.click('#btn-toggle-nova-edicao');
  await page.waitForTimeout(150);
  await page.fill('#nova-edicao-nome', 'Rascunho que não pode sumir');
  await page.waitForTimeout(3800);                   // espera o aviso expirar
  ok('O aviso some sozinho', await page.locator('#toast-host:visible').count() === 0);
  ok('O que estava sendo digitado continua lá depois do aviso sumir', (await page.locator('#nova-edicao-nome').inputValue()) === 'Rascunho que não pode sumir');
  // Um aviso não pode ficar pendurado na tela do próximo usuário do navegador.
  await page.click('[data-save-edicao="2027-1"]');
  await page.waitForTimeout(200);
  ok('Aviso visível antes de sair', await page.locator('#toast-host:visible').count() === 1);
  await logout(page);
  ok('Ao sair, o aviso da sessão anterior some da tela', await page.locator('#toast-host:visible').count() === 0);
  await login(page, 'bruno@example.com');
  await page.click('#btn-goto-admin');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  // Regressão: ao sair e voltar sem nenhum carnaval aberto, o admin via "nenhuma
  // edição cadastrada" — mesmo tendo uma em preparação, que é o caso normal de
  // quem está montando o carnaval do ano seguinte.
  ok('Depois de sair e voltar, o admin continua vendo a edição em preparação', html.includes('Carnaval do Fogo e Paixão 2027') && !html.includes('Nenhuma edição do carnaval cadastrada ainda'));

  console.log('\n== 3c. Nada do que está sendo digitado se perde quando chegam dados de outra pessoa ==');
  // O render() roda a cada dado que chega em tempo real. Antes, isso destruía os
  // campos preenchidos e o foco — a pessoa seguia digitando no vazio.
  await page.click('#btn-goto-edicoes');
  await page.waitForTimeout(200);
  await page.click('#btn-toggle-nova-edicao');
  await page.waitForTimeout(150);
  await page.click('#nova-edicao-nome');
  await page.type('#nova-edicao-nome', 'Carnaval do Fog');
  await page.evaluate(async () => {
    const fb = await import('./firebase-init.mock.js');
    const ref = await fb.addDoc(fb.collection(fb.db, 'pessoas'), { nome: 'zz', sobrenome: 'externo', adminAccess: false });
    await fb.deleteDoc(fb.doc(fb.db, 'pessoas', ref.id));
  });
  await page.waitForTimeout(250);
  ok('O foco continua no campo depois do redesenho', (await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'nova-edicao-nome');
  await page.type('#nova-edicao-nome', 'o e Paixão 2027');
  ok('As letras digitadas depois do redesenho entram no campo certo', (await page.locator('#nova-edicao-nome').inputValue()) === 'Carnaval do Fogo e Paixão 2027');
  await page.click('#btn-toggle-nova-edicao');
  await page.waitForTimeout(150);
  await page.click('#btn-back-admin7');
  await page.waitForTimeout(200);

  console.log('\n== 4. Seed de posições e valores padrão dentro da edição ==');
  html = await appHtml(page);
  ok('Painel admin mostra o aviso de primeiro acesso desta edição', html.includes('Primeiro acesso desta edição'));
  await page.click('#btn-seed-defaults');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Aviso de seed some após carregar os padrões', !html.includes('Primeiro acesso desta edição'));
  ok('Resumo mostra 17 posições, 8 isentas automaticamente', html.includes('17 posições') && html.includes('8 isentas'));

  console.log('\n== 4b. Painel admin separa "um carnaval" de "todos os carnavais" ==');
  ok('Existe a área de acompanhar um carnaval', html.includes('Acompanhar um carnaval'));
  ok('Existe a área do consolidado', html.includes('Todos os carnavais juntos'));
  ok('O seletor de carnaval aparece mesmo havendo só uma edição', (await page.locator('#admin-troca-edicao').count()) === 1);
  // A ordem importa: tudo o que é específico do carnaval vem antes do consolidado,
  // para as duas coisas não se misturarem no meio da página.
  ok('O consolidado vem depois de tudo que é específico do carnaval',
     html.indexOf('Acompanhar um carnaval') < html.indexOf('Cadastros')
     && html.indexOf('Cadastros') < html.indexOf('Todos os carnavais juntos'));
  ok('O histórico geral está dentro da área do consolidado', html.indexOf('Todos os carnavais juntos') < html.indexOf('btn-goto-historico-geral'));
  ok('O consolidado mostra quantos carnavais existem', html.includes('Carnavais registrados'));

  console.log('\n== 5. Abrir a edição para os batuqueiros ==');
  await page.click('#btn-goto-edicoes');
  await page.waitForTimeout(150);
  await page.click('[data-abrir-edicao="2027-1"]');
  await page.waitForTimeout(400);
  html = await appHtml(page);
  ok('Edição passa a constar como Aberta', html.includes('>Aberta<'));
  await page.click('#btn-back-admin7');
  await page.waitForTimeout(150);
  await page.click('#btn-back-batuqueiro');
  await page.waitForTimeout(200);

  console.log('\n== 6. Bruno confirma a própria inscrição na edição recém-aberta ==');
  html = await appHtml(page);
  ok('Quem já tinha cadastro vê a tela de confirmar inscrição', html.includes('Confirmar inscrição'));
  await confirmarInscricao(page, { posicao: 'Outro', posicaoOutro: 'Organização', camisa: 'G' });
  html = await appHtml(page);
  ok('Depois de confirmar, entra na área do batuqueiro', html.includes('Presença em ensaios'));
  await logout(page);

  console.log('\n== 7. Cadastro de mais 3 pessoas com a edição já aberta ==');
  // O cadastro (dados permanentes) e a inscrição no carnaval são passos separados:
  // o que muda todo ano não é perguntado como se fosse parte do cadastro.
  await page.click('#btn-goto-register');
  await page.waitForSelector('#form-register1');
  await page.fill('#reg-email', 'ana@example.com');
  await page.fill('#reg-senha', 'senha123');
  await page.fill('#reg-senha2', 'senha123');
  await page.click('#form-register1 button[type=submit]');
  await page.waitForSelector('#form-register2', { timeout: 5000 });
  html = await appHtml(page);
  ok('O cadastro não pergunta posição/camisa/vai tocar', !html.includes('c-posicao') && !html.includes('radio-camisa') && !html.includes('radio-vaitocar'));
  ok('O cadastro deixa claro que esses dados valem para sempre', html.includes('valem para sempre'));
  ok('Com carnaval aberto, o cadastro anuncia 3 passos', html.includes('Passo 2 de 3'));
  await page.fill('#c-nome', 'Ana');
  await page.fill('#c-sobrenome', 'Silva');
  await page.fill('#c-celular', '(21) 90000-0000');
  await fillDataEmTresCampos(page, 'c-datanasc', '1998-03-15');
  await page.click('#form-register2 button[type=submit]');
  await page.waitForSelector('#form-inscricao', { timeout: 5000 });
  html = await appHtml(page);
  ok('Depois do cadastro vem a inscrição no carnaval, como passo 3', html.includes('Sua inscrição no Carnaval do Fogo e Paixão 2027'));
  ok('A tela explica por que isso é perguntado a cada carnaval', html.includes('a cada novo carnaval o site pergunta isso de novo') || html.includes('A cada novo carnaval o site pergunta isso de novo'));
  await confirmarInscricao(page, { vaiTocar: 'Sim', posicao: 'Surdo 1', camisa: 'M' });
  html = await appHtml(page);
  ok('Ana entra direto na área do batuqueiro (cadastro + inscrição no mesmo passo)', html.includes('Bem-vindo(a), Ana') && html.includes('Presença em ensaios'));
  ok('Sem acesso admin, botão painel admin não aparece', !html.includes('Painel admin'));

  console.log('\n== 8. Editar meus dados (permanentes e do carnaval juntos na mesma tela) ==');
  await page.click('#btn-edit-data');
  await fillDataEmTresCampos(page, 'e-datanasc', '1990-01-20');
  await page.click('#form-edit-mydata button[type=submit]');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Data de nascimento atualizada (20/01/1990)', html.includes('20/01/1990'));

  // Regressão do bug relatado em produção: com dia=05 e mês=novembro (ambos válidos
  // como dia OU mês, o cenário exato onde um <input type="date"> nativo pode trocar
  // dia/mês sem avisar), a idade tem que bater com a data REAL (5 de novembro).
  await page.click('#btn-edit-data');
  await fillDataEmTresCampos(page, 'e-datanasc', '1980-11-05');
  await page.click('#form-edit-mydata button[type=submit]');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Dia/mês não trocam: 05/11/1980 fica 05/11/1980 (não 11/05)', html.includes('05/11/1980'));
  ok('Idade calculada bate com a data real, não com uma troca dia/mês', html.includes('(45 anos)'));
  await logout(page);

  await registrar(page, { email: 'carla@example.com', nome: 'Carla', sobrenome: 'Dias', posicao: 'Voz', camisa: 'P' });
  await logout(page);
  // celular próprio (diferente do padrão) para dar para provar, mais adiante, que
  // o contato de uma pessoa não aparece na sessão de outra
  await registrar(page, { email: 'duda@example.com', nome: 'Duda', sobrenome: 'Reis', apelido: 'Dudinha do Repique', posicao: 'Repique', camisa: 'GG', celular: '(21) 91234-5678' });
  // Verificado aqui, logo depois do cadastro e antes de qualquer edição: é o
  // momento em que um vazamento no formulário de cadastro apareceria.
  const recemCadastrada = await page.evaluate(() => {
    const s = window.__mock.dumpStore();
    const uid = window.__mock.uidPorEmail('duda@example.com');
    return { pessoa: s.pessoas[uid], contato: (s.contatos || {})[uid] };
  });
  ok('O cadastro recém-criado não grava celular na área de leitura geral', !(recemCadastrada.pessoa.celular || '').trim());
  ok('Nem data de nascimento', !(recemCadastrada.pessoa.dataNascimento || '').trim());
  ok('Os dois foram para a área restrita', recemCadastrada.contato.celular === '(21) 91234-5678' && recemCadastrada.contato.dataNascimento === '1996-05-10');

  html = await appHtml(page);
  ok('O site chama a pessoa pelo apelido na saudação', html.includes('Bem-vindo(a), Dudinha do Repique!'));
  ok('A lista de presença mostra o apelido junto do nome completo', html.includes('Duda Reis') && html.includes('Dudinha do Repique'));
  // O apelido é permanente, então fica em "Meus dados" e pode ser mudado ali.
  await page.click('#btn-edit-data');
  await page.waitForTimeout(200);
  ok('O apelido aparece preenchido ao editar meus dados', (await page.locator('#e-apelido').inputValue()) === 'Dudinha do Repique');
  await page.fill('#e-apelido', 'Dudinha');
  await page.click('#form-edit-mydata button[type=submit]');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Apelido alterado passa a valer na saudação', html.includes('Bem-vindo(a), Dudinha!'));
  await logout(page);

  await login(page, 'carla@example.com');
  html = await appHtml(page);
  ok('Quem não preencheu apelido continua sendo chamado pelo primeiro nome', html.includes('Bem-vindo(a), Carla!'));
  ok('E na lista aparece só o nome, sem aspas vazias', html.includes('Carla Dias') && !html.includes('Carla Dias</td>”'));
  await logout(page);

  await login(page, 'bruno@example.com');
  await page.click('#btn-goto-admin');
  await page.waitForTimeout(200);

  console.log('\n== 9. Posições da edição (ordem alfabética, adicionar, editar em lote) ==');
  await page.click('#btn-goto-posicoes');
  await page.waitForTimeout(200);
  html = await appHtml(page);
  ok('Lista de posições carregada (Agogô presente)', html.includes('value="Agogô"'));

  const nomesNaTela = await page.$$eval('.pos-name-input', els => els.map(e => e.value));
  const nomesOrdenados = [...nomesNaTela].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
  ok('Posições aparecem em ordem alfabética', JSON.stringify(nomesNaTela) === JSON.stringify(nomesOrdenados));

  await page.fill('#new-posicao-nome', 'Bateria Extra');
  await page.click('#btn-add-posicao');
  await page.waitForTimeout(250);
  html = await appHtml(page);
  ok('Nova posição "Bateria Extra" adicionada', html.includes('Bateria Extra'));
  ok('Não sobrou botão de salvar individual por posição (só o botão único)', !html.includes('data-save-posicao'));

  console.log('\n== 9b. Edições não somem mesmo se a tela for re-renderizada antes de salvar ==');
  // Usa locators (re-resolvidos no momento da ação) em vez de guardar handles:
  // o render() troca os elementos do DOM, e um handle antigo fica órfão.
  await page.locator('input.pos-name-input').nth(0).fill('XYZ-Editado-1');
  await page.locator('input.pos-name-input').nth(1).fill('XYZ-Editado-2');
  // Simula uma atualização em segundo plano (outra pessoa mexendo no sistema em
  // tempo real) chamando o Firestore simulado diretamente — dispara um onSnapshot
  // e um render() completo, sem nenhum clique do admin.
  await page.evaluate(async () => {
    const fb = await import('./firebase-init.mock.js');
    const ref = await fb.addDoc(fb.collection(fb.db, 'edicoes', '2027-1', 'ensaios'), { data: '2030-01-01' });
    await fb.deleteDoc(fb.doc(fb.db, 'edicoes', '2027-1', 'ensaios', ref.id));
  });
  await page.waitForTimeout(250);
  const valoresAposRerender = await page.$$eval('input.pos-name-input', els => els.map(e => e.value));
  ok('Edição não salva sobrevive a um re-render em segundo plano', valoresAposRerender.includes('XYZ-Editado-1') && valoresAposRerender.includes('XYZ-Editado-2'));

  await page.click('#btn-save-all-posicoes');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('As duas edições em lote foram salvas de uma vez', html.includes('XYZ-Editado-1') && html.includes('XYZ-Editado-2'));
  await page.click('#btn-back-admin');
  await page.waitForTimeout(200);

  console.log('\n== 10. Preços e prazos da edição ==');
  await page.click('#btn-goto-precos');
  await page.waitForTimeout(200);
  await page.fill('#admin-preco-avista', '210');
  await page.fill('#admin-prazo-avista-0', '2026-12-01');
  await page.fill('#admin-preco-duasVezes', '230');
  await page.fill('#admin-prazo-duasVezes-0', '2026-11-01');
  await page.fill('#admin-prazo-duasVezes-1', '2026-12-15');
  await page.fill('#admin-preco-tresVezes', '250');
  await page.fill('#admin-prazo-tresVezes-0', '2026-10-01');
  await page.fill('#admin-prazo-tresVezes-1', '2026-11-15');
  await page.fill('#admin-prazo-tresVezes-2', '2026-12-30');
  await page.click('#btn-save-precos');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Preços salvos sem erro (segue na tela de preços)', html.includes('Valores e datas-limite'));
  await page.click('#btn-back-admin3');
  await page.waitForTimeout(200);

  console.log('\n== 11. Ensaios da edição ==');
  await page.click('#btn-goto-ensaios');
  await page.waitForTimeout(200);
  const hoje = new Date();
  const passado = new Date(hoje.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const futuro1 = new Date(hoje.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const futuro2 = new Date(hoje.getTime() + 14 * 86400000).toISOString().slice(0, 10);
  for (const d of [passado, futuro1, futuro2]) {
    await page.fill('#new-ensaio-data', d);
    await page.click('#btn-add-ensaio');
    await page.waitForTimeout(200);
  }
  html = await appHtml(page);
  ok('3 ensaios cadastrados', (html.match(/ensaio-data-input/g) || []).length === 3);
  ok('Ensaio passado marcado como Realizado', html.includes('Realizado'));
  ok('Ensaios futuros marcados como Agendado', html.includes('Agendado'));
  // A data do ensaio precisa gravar sozinha ao mudar. Antes dependia de um botão
  // "Salvar" por linha, e como um redesenho em segundo plano repõe no campo o que
  // foi digitado, a tela do admin continuava mostrando a data nova sem ter salvo
  // nada — enquanto os batuqueiros seguiam vendo a data antiga.
  const idPrimeiroEnsaio = await page.evaluate(() => document.querySelector('.ensaio-data-input').dataset.ensaioId);
  const dataOriginal = await page.inputValue(`.ensaio-data-input[data-ensaio-id="${idPrimeiroEnsaio}"]`);
  await page.fill(`.ensaio-data-input[data-ensaio-id="${idPrimeiroEnsaio}"]`, '2026-12-22');
  await page.waitForTimeout(500);
  const gravado = await page.evaluate((id) => window.__mock.dumpStore()['edicoes/2027-1/ensaios'][id].data, idPrimeiroEnsaio);
  ok('Trocar a data do ensaio grava sozinho, sem botão de salvar', gravado === '2026-12-22');
  await page.click('#btn-back-admin4');
  await page.waitForTimeout(200);
  await page.click('#btn-back-batuqueiro');
  await page.waitForTimeout(400);
  html = await appHtml(page);
  ok('E a data nova aparece na tabela de presença do batuqueiro', html.includes('22/12/2026'));
  ok('Sem sobrar a data antiga', !html.includes('05/11/2026') || dataOriginal !== '2026-11-05');
  // devolve a data original para o resto da suíte
  await page.click('#btn-goto-admin');
  await page.waitForTimeout(250);
  await page.click('#btn-goto-ensaios');
  await page.waitForTimeout(250);
  await page.fill(`.ensaio-data-input[data-ensaio-id="${idPrimeiroEnsaio}"]`, dataOriginal);
  await page.waitForTimeout(500);
  await page.click('#btn-back-admin4');
  await page.waitForTimeout(200);

  console.log('\n== 12. Repertório de músicas da edição (com tom e cantor) ==');
  await page.click('#btn-goto-musicas');
  await page.waitForTimeout(200);
  html = await appHtml(page);
  ok('Sem músicas cadastradas ainda, mostra aviso', html.includes('Nenhuma música cadastrada ainda.'));

  await page.fill('#new-musica-nome', 'Ventania');
  await page.fill('#new-musica-tom', 'Sol maior');
  await page.fill('#new-musica-cantor', 'Carla');
  await page.click('#btn-add-musica');
  await page.waitForTimeout(250);
  html = await appHtml(page);
  ok('Música salva com tom e cantor(a) preenchidos', html.includes('value="Sol maior"') && html.includes('value="Carla"'));

  const tonsSugeridos = await page.$$eval('#lista-tons option', els => els.map(e => e.value));
  ok('Tom já usado (Sol maior) vira sugestão (datalist) para a próxima música', tonsSugeridos.includes('Sol maior'));
  const cantoresSugeridos = await page.$$eval('#lista-cantores option', els => els.map(e => e.value));
  ok('Cantor(a) já usado (Carla) vira sugestão (datalist) para a próxima música', cantoresSugeridos.includes('Carla'));

  await page.fill('#new-musica-nome', 'Aquarela');
  await page.click('#btn-add-musica');
  await page.waitForTimeout(250);
  const nomesMusicasNaTela = await page.$$eval('.musica-name-input', els => els.map(e => e.value));
  ok('Músicas em ordem alfabética (Aquarela antes de Ventania)', nomesMusicasNaTela.indexOf('Aquarela') < nomesMusicasNaTela.indexOf('Ventania'));
  const tonsNaTela = await page.$$eval('.musica-tom-input', els => els.map(e => e.value));
  ok('Aquarela fica com tom em branco, sem herdar o de Ventania', tonsNaTela[nomesMusicasNaTela.indexOf('Aquarela')] === '');

  await page.locator('input.musica-name-input').nth(0).fill('Aquarela (Editada)');
  await page.evaluate(async () => {
    const fb = await import('./firebase-init.mock.js');
    const ref = await fb.addDoc(fb.collection(fb.db, 'edicoes', '2027-1', 'ensaios'), { data: '2030-02-02' });
    await fb.deleteDoc(fb.doc(fb.db, 'edicoes', '2027-1', 'ensaios', ref.id));
  });
  await page.waitForTimeout(250);
  const valoresMusicasAposRerender = await page.$$eval('input.musica-name-input', els => els.map(e => e.value));
  ok('Edição de música não salva sobrevive a um re-render em segundo plano', valoresMusicasAposRerender.includes('Aquarela (Editada)'));

  await page.click('#btn-save-all-musicas');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Edição da música foi salva', html.includes('value="Aquarela (Editada)"'));
  await page.click('#btn-back-admin6');
  await page.waitForTimeout(200);
  html = await appHtml(page);
  ok('Card do painel admin mostra "2 músicas cadastradas"', html.includes('2 músicas cadastradas'));

  console.log('\n== 13. Marcar músicas ensaiadas num ensaio ==');
  await page.click('#btn-goto-ensaios');
  await page.waitForTimeout(200);
  await page.click('[data-toggle-musicas-ensaio]');
  await page.waitForTimeout(200);
  html = await appHtml(page);
  ok('Editor de músicas do ensaio abre com as opções cadastradas', html.includes('Aquarela (Editada)') && html.includes('Ventania'));
  ok('Editor mostra o tom e o cantor(a) cadastrados (Sol maior · Carla)', html.includes('Sol maior') && html.includes('Carla'));

  await page.locator('label:has-text("Ventania") input.musica-ensaio-check').check();
  await page.waitForTimeout(150);
  await page.evaluate(async () => {
    const fb = await import('./firebase-init.mock.js');
    const ref = await fb.addDoc(fb.collection(fb.db, 'edicoes', '2027-1', 'ensaios'), { data: '2030-03-03' });
    await fb.deleteDoc(fb.doc(fb.db, 'edicoes', '2027-1', 'ensaios', ref.id));
  });
  await page.waitForTimeout(250);
  const marcado = await page.locator('label:has-text("Ventania") input.musica-ensaio-check').first().isChecked();
  ok('Marcação de música (não salva) sobrevive a um re-render em segundo plano', marcado);

  await page.click('[data-save-musicas-ensaio]');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Música aparece marcada como ensaiada, com tom e cantor, na linha do ensaio', html.includes('Ventania (Sol maior · Carla)'));
  await page.click('#btn-back-admin4');
  await page.waitForTimeout(200);

  console.log('\n== 14. Cadastros: isenção individual e acesso admin ==');
  await page.click('#btn-goto-pessoas');
  await page.waitForTimeout(200);
  html = await appHtml(page);
  ok('Lista mostra Ana, Bruno, Carla e Duda inscritos na edição', ['Ana Silva', 'Bruno Costa', 'Carla Dias', 'Duda Reis'].every(n => html.includes(n)));
  ok('Carla (Voz) já aparece isenta automaticamente pela posição', html.includes('Isento') && html.includes('Carla'));

  const uids = await page.evaluate(() => ({
    ana: window.__mock.uidPorEmail('ana@example.com'),
    carla: window.__mock.uidPorEmail('carla@example.com'),
    duda: window.__mock.uidPorEmail('duda@example.com'),
  }));
  await page.click(`[data-edit-user="${uids.ana}"]`);
  await page.waitForTimeout(200);
  await page.check(`#ae-isento-${uids.ana}`);
  await page.check(`#ae-adminaccess-${uids.ana}`);
  await page.click(`[data-admin-edit-form="${uids.ana}"] button[type=submit]`);
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Ana agora aparece com badge "Acesso admin"', html.includes('Acesso admin'));
  await page.click('#btn-back-admin2');
  await page.waitForTimeout(200);

  console.log('\n== 15. Relatório geral com filtros ==');
  await page.click('#btn-goto-relatorio');
  await page.waitForTimeout(200);
  html = await appHtml(page);
  ok('Relatório lista todas as pessoas da edição', html.includes('Ana Silva') && html.includes('Duda Reis'));
  await page.selectOption('#relatorio-filtro-posicao', 'Repique');
  await page.waitForTimeout(200);
  html = await appHtml(page);
  ok('Filtro por posição (Repique) mostra só Duda', html.includes('Duda Reis') && !html.includes('Bruno Costa'));
  await page.selectOption('#relatorio-filtro-posicao', 'todas');
  await page.waitForTimeout(150);
  await logout(page);

  // ============================================================
  console.log('\n== 16. Ana: isenção, plano de pagamento e pagamento parcial ==');
  await login(page, 'ana@example.com');
  html = await appHtml(page);
  ok('Ana (isenta manual) vê "Anuidade ISENTA" e não vê formulário de plano', html.includes('Anuidade ISENTA'));
  await logout(page);

  await login(page, 'bruno@example.com');
  await page.click('#btn-goto-admin');
  await page.click('#btn-goto-pessoas');
  await page.waitForTimeout(200);
  await page.click(`[data-edit-user="${uids.ana}"]`);
  await page.waitForTimeout(200);
  await page.uncheck(`#ae-isento-${uids.ana}`);
  await page.click(`[data-admin-edit-form="${uids.ana}"] button[type=submit]`);
  await page.waitForTimeout(300);
  await logout(page);

  await login(page, 'ana@example.com');
  html = await appHtml(page);
  ok('Sem isenção, Ana vê os planos de pagamento', html.includes('plan-picker'));
  await page.click('#plan-picker .plan-pill[data-plano="duasVezes"]');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Após escolher plano 2x, mostra 2 parcelas', (html.match(/Parcela \d\/2/g) || []).length === 2);

  await page.click('#btn-toggle-addpay');
  await page.fill('#pay-data', hoje.toISOString().slice(0, 10));
  await page.fill('#pay-valor', '115');
  await page.fill('#pay-pix', 'ana@pix');
  await page.click('#btn-save-pay');
  await page.waitForTimeout(400);
  html = await appHtml(page);
  ok('Pagamento de R$115 registrado na lista', html.includes('ana@pix'));
  ok('A lista identifica quem fez o Pix, não uma chave', html.includes('Pago por:'));
  // A forma de pagamento trava no primeiro pagamento: trocar depois mudaria o
  // valor devido deixando o que já foi pago sem referência.
  ok('O botão de trocar a forma de pagamento some depois do 1º pagamento', !html.includes('btn-change-plan'));
  ok('E o site explica por que sumiu', html.includes('não pode mais ser trocada'));
  ok('Total pago (115 de 230, 50%) refletido na barra de progresso', html.includes('50%'));
  ok('Status muda para "No prazo" (não quitado ainda)', html.includes('No prazo'));

  console.log('\n== 16a. O admin destrava a forma de pagamento que travou para o batuqueiro ==');
  // Como o botão do batuqueiro some no 1º pagamento, o painel de Cadastros é a
  // única saída quando alguém escolheu o plano errado.
  await logout(page);
  await login(page, 'bruno@example.com');
  await page.click('#btn-goto-admin');
  await page.click('#btn-goto-pessoas');
  await page.waitForTimeout(200);
  await page.click(`[data-edit-user="${uids.ana}"]`);
  await page.waitForTimeout(200);
  html = await appHtml(page);
  ok('O formulário de Cadastros tem o campo de forma de pagamento', html.includes(`ae-formapagamento-${uids.ana}`));
  await page.selectOption(`#ae-formapagamento-${uids.ana}`, 'avista');
  await page.click(`[data-admin-edit-form="${uids.ana}"] button[type=submit]`);
  await page.waitForTimeout(350);
  await logout(page);

  await login(page, 'ana@example.com');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Ana passa a ver o plano à vista trocado pelo admin', html.includes('Parcela 1/1'));
  ok('E o que ela já pagou continua contando (115 de 210 = 55%)', html.includes('55%'));

  // devolve o plano 2x para as seções seguintes continuarem valendo
  await logout(page);
  await login(page, 'bruno@example.com');
  await page.click('#btn-goto-admin');
  await page.click('#btn-goto-pessoas');
  await page.waitForTimeout(200);
  await page.click(`[data-edit-user="${uids.ana}"]`);
  await page.waitForTimeout(200);
  await page.selectOption(`#ae-formapagamento-${uids.ana}`, 'duasVezes');
  await page.click(`[data-admin-edit-form="${uids.ana}"] button[type=submit]`);
  await page.waitForTimeout(350);
  await logout(page);

  await login(page, 'ana@example.com');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('E o admin consegue devolver o plano 2x (volta para 50%)', html.includes('50%'));

  console.log('\n== 16a2. Deixando em branco quem pagou, entra o nome da própria pessoa ==');
  // O campo existe para o caso de o Pix sair da conta de outra pessoa. Quem
  // pagou da própria conta não deveria ter que digitar o próprio nome.
  await page.click('#btn-toggle-addpay');
  await page.waitForTimeout(200);
  const sugestao = await page.getAttribute('#pay-pix', 'placeholder');
  ok('O campo já sugere o nome da própria pessoa', sugestao === 'Ana Silva');
  await page.fill('#pay-data', hoje.toISOString().slice(0, 10));
  await page.fill('#pay-valor', '5');
  await page.click('#btn-save-pay');
  await page.waitForTimeout(500);
  const semNome = await page.evaluate(() => {
    const uid = window.__mock.uidPorEmail('ana@example.com');
    const pags = Object.values(window.__mock.dumpStore()['edicoes/2027-1/pagamentos']).filter(p => p.uid === uid);
    return pags[pags.length - 1];
  });
  ok('Em branco, o pagamento fica no nome de quem registrou', semNome.pix === 'Ana Silva');
  // desfaz o lançamento de teste (pelo mock, já que o site não apaga pagamento)
  // para as contas do restante da suíte continuarem valendo
  await page.evaluate(async () => {
    const fb = await import('./firebase-init.mock.js');
    const uid = window.__mock.uidPorEmail('ana@example.com');
    const loja = window.__mock.dumpStore()['edicoes/2027-1/pagamentos'];
    const id = Object.keys(loja).filter(k => loja[k].uid === uid && loja[k].valor === 5)[0];
    if (id) await fb.deleteDoc(fb.doc(fb.db, 'edicoes', '2027-1', 'pagamentos', id));
    await fb.updateDoc(fb.doc(fb.db, 'edicoes', '2027-1', 'inscricoes', uid), { totalPago: 115 });
  });
  await page.waitForTimeout(400);

  console.log('\n== 16b. Chave Pix configurada pelo admin aparece para quem vai pagar ==');
  await logout(page);
  await login(page, 'bruno@example.com');
  await page.click('#btn-goto-admin');
  await page.waitForTimeout(200);
  await page.click('#btn-goto-precos');
  await page.waitForTimeout(250);
  await page.fill('#admin-chave-pix', 'bateria@pix.com');
  await page.click('#btn-save-precos');
  await page.waitForTimeout(350);
  await logout(page);

  await login(page, 'ana@example.com');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('A chave Pix aparece na área de pagamento do batuqueiro', html.includes('bateria@pix.com'));
  ok('Com botão para copiar', html.includes('btn-copiar-pix'));
  ok('E a instrução de que o pix só conta depois de registrado', html.includes('só entra na sua conta o que for registrado'));

  console.log('\n== 16c. Quem não vai tocar fica isento da anuidade ==');
  // Regra da bateria: só paga quem desfila. A isenção por não tocar convive com
  // as outras duas (por função e a individual).
  await page.click('#btn-edit-data');
  await page.waitForTimeout(250);
  await page.click('#edit-radio-vaitocar .radio-pill[data-val="Não"]');
  // "Vai tocar" e "camisa" são <div> com classe .active, não <input> — não eram
  // fotografados antes de um redesenho e voltavam para o valor salvo em
  // silêncio. Qualquer dado chegando em tempo real (outra pessoa marcando
  // presença, o admin mexendo em algo) redesenha a tela; aqui simulamos isso.
  await page.evaluate(async () => {
    const fb = await import('./firebase-init.mock.js');
    const ref = await fb.addDoc(fb.collection(fb.db, 'edicoes', '2027-1', 'ensaios'), { data: '2030-03-03' });
    await fb.deleteDoc(fb.doc(fb.db, 'edicoes', '2027-1', 'ensaios', ref.id));
  });
  await page.waitForTimeout(300);
  const escolhaSobreviveu = await page.locator('#edit-radio-vaitocar .radio-pill.active').getAttribute('data-val');
  ok('A escolha "não vou tocar" sobrevive a um re-render em segundo plano', escolhaSobreviveu === 'Não');
  await page.click('#form-edit-mydata button[type=submit]');
  await page.waitForTimeout(400);
  html = await appHtml(page);
  ok('Ao marcar que não vai tocar, a anuidade fica isenta', html.includes('Anuidade ISENTA'));
  ok('O motivo mostrado é o certo', html.includes('você não vai tocar neste carnaval'));
  ok('Não aparece mais escolha de forma de pagamento', !html.includes('plan-picker'));
  // Ela já tinha pago R$115 antes: esse dinheiro não pode sumir da tela dela.
  ok('O que ela já tinha pago continua visível', html.includes('Pagamentos que você já tinha registrado') && html.includes('ana@pix'));
  ok('Com orientação de procurar a organização', html.includes('devolução ou o crédito'));
  // Quem não vai tocar não vai a ensaio: a linha dela sai da tabela de presença,
  // que antes ficava cheia de gente que nunca seria marcada.
  ok('Ela sai da tabela de presença dos ensaios', !html.includes(`data-uid="${uids.ana}"`));
  ok('Mas a tabela continua lá, com quem vai desfilar', html.includes(`data-uid="${uids.duda}"`));

  // O histórico calculava a isenção com só duas das três regras e esquecia a
  // principal — a de não ir tocar. Ana está com plano 2x e prazos em aberto,
  // então sem a correção esta linha voltava como "No prazo", cobrando alguém
  // que a própria tela anterior acabou de declarar isento.
  await page.click('#btn-goto-historico');
  await page.waitForTimeout(700);
  html = await appHtml(page);
  ok('No "meu histórico", o carnaval em que ela não vai tocar aparece como Isenta', html.includes('Isenta'));
  ok('E não como cobrança em aberto', !html.includes('No prazo'));
  await page.click('#btn-back-from-historico');
  await page.waitForTimeout(300);

  await logout(page);
  await login(page, 'bruno@example.com');
  await page.click('#btn-goto-admin');
  await page.waitForTimeout(250);
  html = await appHtml(page);
  ok('Ela sai das listas do carnaval e vira contagem à parte no painel', html.includes('Avisaram que não vão tocar'));
  ok('E o painel avisa onde ela foi parar', html.includes('aparece em Cadastros, num bloco separado'));
  ok('O painel passa a contar 3 pessoas para desfilar, não 4', html.includes('3 pessoas vão desfilar neste carnaval'));
  ok('E registra 1 pessoa fora deste carnaval', html.includes('1 avisaram que não vão tocar'));
  // Camisa é do desfile: quem não vai tocar não entra na encomenda. Ana usa M,
  // e ela era a única M — o tamanho tem que sumir da tabela de camisas.
  const tabelaCamisas = await page.evaluate(() => {
    const t = [...document.querySelectorAll('#app table')].find(x => x.textContent.includes('Camisa') && x.textContent.includes('Quantas'));
    return t ? t.textContent : '';
  });
  ok('A encomenda de camisas conta só quem vai desfilar', tabelaCamisas && !/\bM\b/.test(tabelaCamisas.replace('Camisa', '')));

  await page.click('#btn-goto-pessoas');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Em Cadastros existe um bloco próprio para quem não vai tocar', html.includes('Não vão tocar no Carnaval do Fogo e Paixão 2027'));
  ok('O bloco explica que o cadastro e o histórico continuam intactos', html.includes('o cadastro e o histórico delas continuam intactos'));
  // A lista principal ("Quem vai desfilar") não pode mais conter a Ana; o bloco
  // separado, sim. Compara a posição das duas ocorrências no HTML.
  const posBloco = html.indexOf('Não vão tocar no Carnaval');
  const ocorrenciasAna = [...html.matchAll(/Ana Silva/g)].map(m => m.index);
  ok('Ana saiu da lista de quem vai desfilar', ocorrenciasAna.every(i => i > posBloco));
  ok('E aparece no bloco separado', ocorrenciasAna.length > 0);
  ok('Com aviso de que ela pagou e o valor precisa ser resolvido', html.includes('ver devolução'));
  await page.click('#btn-back-admin2');
  await page.waitForTimeout(200);

  await page.click('#btn-goto-relatorio');
  await page.waitForTimeout(250);
  html = await appHtml(page);
  ok('O relatório de cobrança não lista mais quem não vai tocar', html.indexOf('Ana Silva') > html.indexOf('Pagaram, mas não vão tocar'));
  ok('Mas há um bloco de quem pagou e não vai desfilar', html.includes('Pagaram, mas não vão tocar'));
  ok('Com o valor que precisa ser devolvido ou creditado', html.includes('115'));
  await page.click('#btn-back-admin5');
  await page.waitForTimeout(200);

  // O admin também consegue corrigir o "vai tocar" de alguém, sem depender de a
  // própria pessoa entrar no site.
  await page.click('#btn-goto-pessoas');
  await page.waitForTimeout(300);
  await page.click(`[data-edit-user="${uids.ana}"]`);
  await page.waitForTimeout(250);
  ok('O formulário do admin tem o campo "vai tocar"', (await page.locator(`#ae-vaitocar-${uids.ana}`).inputValue()) === 'Não');
  await page.selectOption(`#ae-vaitocar-${uids.ana}`, 'Sim');
  await page.click(`[data-admin-edit-form="${uids.ana}"] button[type=submit]`);
  await page.waitForTimeout(400);
  html = await appHtml(page);
  ok('Trocando para Sim pelo painel, ela volta para a lista de quem desfila', html.indexOf('Ana Silva') < (html.indexOf('Não vão tocar no Carnaval') === -1 ? Infinity : html.indexOf('Não vão tocar no Carnaval')));
  ok('E o bloco de quem não vai tocar some quando esvazia', !html.includes('Não vão tocar no Carnaval'));
  await page.click('#btn-back-admin2');
  await page.waitForTimeout(200);
  await logout(page);

  // devolve a Ana ao estado anterior para o restante da suíte
  await login(page, 'ana@example.com');
  await page.click('#btn-edit-data');
  await page.waitForTimeout(250);
  await page.click('#edit-radio-vaitocar .radio-pill[data-val="Sim"]');
  await page.click('#form-edit-mydata button[type=submit]');
  await page.waitForTimeout(400);
  html = await appHtml(page);
  ok('Voltando a tocar, a cobrança volta com o valor já pago preservado', html.includes('50%'));

  console.log('\n== 16d. Celular e nascimento ficam fora do cadastro que todos leem ==');
  // /pessoas é lido por qualquer pessoa logada (é o que monta a lista da bateria
  // e a presença), e regra do Firestore não filtra campo, só documento. Por isso
  // o contato mora em /contatos, cuja listagem exige admin — o mock reproduz
  // exatamente essa regra, então um listener aberto para a pessoa errada falha.
  const layout = await page.evaluate(() => {
    const s = window.__mock.dumpStore();
    const uid = window.__mock.uidPorEmail('ana@example.com');
    return { pessoa: s.pessoas[uid], contato: (s.contatos || {})[uid] };
  });
  ok('O cadastro público não guarda celular', !(layout.pessoa.celular || '').trim());
  ok('Nem data de nascimento', !(layout.pessoa.dataNascimento || '').trim());
  ok('O celular está em /contatos', !!(layout.contato && layout.contato.celular));
  ok('A data de nascimento também', !!(layout.contato && layout.contato.dataNascimento));

  html = await appHtml(page);
  ok('Ana continua vendo o próprio celular em "Meus dados"', html.includes('90000-0000'));

  const negadasAntes = await page.evaluate(() => window.__mock.leiturasNegadas());
  await logout(page);
  await login(page, 'duda@example.com');
  await page.waitForTimeout(400);
  const negadasDepois = await page.evaluate(() => window.__mock.leiturasNegadas());
  // O app nem chega a pedir a listagem quando não é admin — se pedisse, contra o
  // Firestore de verdade viraria erro de permissão em produção.
  ok('O site não tenta ler o contato dos outros quando quem entrou não é admin', negadasDepois === negadasAntes);
  html = await appHtml(page);
  ok('Duda vê o próprio celular normalmente', html.includes('91234-5678'));
  ok('E o celular da Ana não chega em lugar nenhum da tela dela', !html.includes('90000-0000'));

  await logout(page);
  await login(page, 'ana@example.com');
  await page.click('#btn-goto-admin');
  await page.click('#btn-goto-pessoas');
  await page.waitForTimeout(300);
  await page.click(`[data-edit-user="${uids.duda}"]`);
  await page.waitForTimeout(250);
  const celularVistoPeloAdmin = await page.inputValue(`#ae-celular-${uids.duda}`);
  ok('A organização enxerga o contato de todos (aqui o da Duda)', celularVistoPeloAdmin === '(21) 91234-5678');
  await page.fill(`#ae-celular-${uids.duda}`, '(21) 98888-0000');
  await page.click(`[data-admin-edit-form="${uids.duda}"] button[type=submit]`);
  await page.waitForTimeout(400);
  const aposEdicaoAdmin = await page.evaluate(() => {
    const s = window.__mock.dumpStore();
    const uid = window.__mock.uidPorEmail('duda@example.com');
    return { pessoa: s.pessoas[uid], contato: (s.contatos || {})[uid] };
  });
  ok('E consegue corrigir esse contato pelo painel', aposEdicaoAdmin.contato.celular === '(21) 98888-0000');
  ok('A correção foi para /contatos, não para o cadastro que todos leem', !(aposEdicaoAdmin.pessoa.celular || '').trim());
  await page.click('#btn-back-admin2');
  await page.waitForTimeout(200);
  await page.click('#btn-back-batuqueiro');
  await page.waitForTimeout(250);

  console.log('\n== 16e. O rodapé explica o que é guardado e quem vê o quê ==');
  const rodapeHtml = await page.evaluate(() => document.querySelector('.rodape')?.innerHTML || '');
  ok('O aviso de privacidade aparece no rodapé', rodapeHtml.includes('Privacidade'));
  ok('Diz para que os dados servem', rodapeHtml.includes('organizar a bateria'));
  ok('Diz que o celular só é visto pela pessoa e pela organização', rodapeHtml.includes('celular e sua data de nascimento'));
  ok('E fala do direito de correção e exclusão', rodapeHtml.includes('exclusão'));

  console.log('\n== 16f. Dois toques no botão de salvar pagamento não lançam em dobro ==');
  // As regras proíbem editar ou apagar pagamento, então um lançamento duplicado
  // só sairia por escrita direta no Firebase Console. No celular, o toque duplo
  // é comum o bastante para valer a trava.
  const antesDoDuplo = await page.evaluate(() => {
    const uid = window.__mock.uidPorEmail('ana@example.com');
    const s = window.__mock.dumpStore();
    return {
      total: s['edicoes/2027-1/inscricoes'][uid].totalPago,
      lancamentos: Object.values(s['edicoes/2027-1/pagamentos'] || {}).filter(p => p.uid === uid).length,
    };
  });
  await page.click('#btn-toggle-addpay');
  await page.waitForTimeout(200);
  await page.fill('#pay-data', hoje.toISOString().slice(0, 10));
  await page.fill('#pay-valor', '10');
  await page.fill('#pay-pix', 'ana@pix');
  // Os dois cliques precisam sair no MESMO tique do navegador: é assim que o
  // toque duplo acontece de verdade, com o segundo caindo antes de o primeiro
  // terminar de gravar. Dois page.click() seriam sequenciais e não reproduzem.
  await page.evaluate(() => { const b = document.getElementById('btn-save-pay'); b.click(); b.click(); });
  await page.waitForTimeout(700);
  const depoisDoDuplo = await page.evaluate(() => {
    const uid = window.__mock.uidPorEmail('ana@example.com');
    const s = window.__mock.dumpStore();
    return {
      total: s['edicoes/2027-1/inscricoes'][uid].totalPago,
      lancamentos: Object.values(s['edicoes/2027-1/pagamentos'] || {}).filter(p => p.uid === uid).length,
    };
  });
  ok('O valor entrou uma vez só no total', depoisDoDuplo.total === antesDoDuplo.total + 10);
  ok('E gerou um único comprovante', depoisDoDuplo.lancamentos === antesDoDuplo.lancamentos + 1);

  console.log('\n== 16g. Exportar a lista de cadastros ==');
  await page.click('#btn-goto-admin');
  await page.click('#btn-goto-pessoas');
  await page.waitForTimeout(300);
  const [baixadoCsv] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-exportar-csv'),
  ]);
  ok('O arquivo CSV sai com o carnaval e a data no nome', /^batuqueiros-2027-1-\d{4}-\d{2}-\d{2}\.csv$/.test(baixadoCsv.suggestedFilename()));
  const csv = readFileSync(await baixadoCsv.path(), 'utf8');
  const linhasCsv = csv.replace(/^\uFEFF/, '').split('\r\n');
  // Sem o BOM o Excel abre "Jos<C3><A9>" no lugar de "José"; sem o ponto-e-vírgula
  // ele joga a linha inteira numa coluna só, porque aqui a vírgula é decimal.
  ok('Começa com o BOM que faz o Excel ler os acentos', csv.charCodeAt(0) === 0xFEFF);
  ok('A primeira linha avisa que há dados pessoais no arquivo', linhasCsv[0].includes('contém dados pessoais'));
  const colunasCsv = linhasCsv[1].split(';');
  ok('O cabeçalho traz os dados permanentes e os do carnaval', colunasCsv.includes('Nome') && colunasCsv.includes('Celular') && colunasCsv.includes('Posição') && colunasCsv.includes('Situação'));
  ok('E também presença e acessos', colunasCsv.includes('Presenças') && colunasCsv.includes('Acesso admin'));
  const linhaAnaCsv = linhasCsv.find(l => l.startsWith('Ana;'));
  ok('Ana aparece na planilha', !!linhaAnaCsv);
  const celulasAna = linhaAnaCsv.split(';');
  ok('Com o celular dela, que só o admin enxerga', celulasAna[colunasCsv.indexOf('Celular')] === '(21) 90000-0000');
  ok('Com a posição do carnaval selecionado', celulasAna[colunasCsv.indexOf('Posição')] === 'Surdo 1');
  // Valor com vírgula decimal: 230 devido, 125 pagos (115 + os 10 do teste 16f).
  ok('Valor devido no formato brasileiro', celulasAna[colunasCsv.indexOf('Valor devido')] === '230');
  ok('Saldo calculado (230 - 125)', celulasAna[colunasCsv.indexOf('Saldo')] === '105');
  ok('Uma linha por pessoa inscrita, mais aviso e cabeçalho', linhasCsv.length === 4 + 2);

  // Um apelido com ponto-e-vírgula quebraria a planilha em colunas erradas, e um
  // com aspas quebraria o campo — os dois precisam sair escapados.
  await page.click(`[data-edit-user="${uids.duda}"]`);
  await page.waitForTimeout(250);
  await page.fill(`#ae-apelido-${uids.duda}`, 'Dudinha "do; Repique"');
  await page.click(`[data-admin-edit-form="${uids.duda}"] button[type=submit]`);
  await page.waitForTimeout(400);
  const [baixadoEscape] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-exportar-csv'),
  ]);
  const csvEscape = readFileSync(await baixadoEscape.path(), 'utf8').replace(/^\uFEFF/, '').split('\r\n');
  const linhaDudaCsv = csvEscape.find(l => l.startsWith('Duda;'));
  ok('Ponto-e-vírgula e aspas no apelido saem escapados', linhaDudaCsv.includes('"Dudinha ""do; Repique"""'));
  await page.click(`[data-edit-user="${uids.duda}"]`);
  await page.waitForTimeout(250);
  await page.fill(`#ae-apelido-${uids.duda}`, 'Dudinha');
  await page.click(`[data-admin-edit-form="${uids.duda}"] button[type=submit]`);
  await page.waitForTimeout(400);
  // O filtro de posição da tela não pode encolher o arquivo: quem exporta quer a
  // lista inteira, e o filtro é só uma lente para olhar a tela.
  await page.selectOption('#admin-pessoas-filtro', 'Repique');
  await page.waitForTimeout(250);
  const [baixadoFiltrado] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-exportar-csv'),
  ]);
  const csvFiltrado = readFileSync(await baixadoFiltrado.path(), 'utf8').replace(/^\uFEFF/, '').split('\r\n');
  ok('O filtro de posição da tela não encolhe a planilha', csvFiltrado.length === linhasCsv.length);
  await page.selectOption('#admin-pessoas-filtro', 'todas');
  await page.waitForTimeout(200);

  console.log('\n== 16h. Excel (.xlsx): geração e queda para CSV se a biblioteca não carregar ==');
  // A biblioteca que gera .xlsx vem de um CDN e não faz parte do site. Aqui ela
  // é substituída por uma dublê que só registra o que recebeu — assim dá para
  // conferir o conteúdo da planilha sem depender da internet no teste.
  await page.evaluate(() => {
    window.__matrizXlsx = null;
    window.XLSX = {
      utils: {
        aoa_to_sheet: m => { window.__matrizXlsx = m; return {}; },
        book_new: () => ({ abas: [] }),
        book_append_sheet: (livro, aba, nome) => { window.__nomeAba = nome; },
      },
      write: () => new Uint8Array([80, 75, 3, 4]),
    };
  });
  const [baixadoXlsx] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-exportar-xlsx'),
  ]);
  ok('O arquivo Excel sai com extensão .xlsx', baixadoXlsx.suggestedFilename().endsWith('.xlsx'));
  const matriz = await page.evaluate(() => window.__matrizXlsx);
  ok('A aba tem nome', (await page.evaluate(() => window.__nomeAba)) === 'Batuqueiros');
  ok('A planilha começa pelo aviso de dados pessoais', matriz[0][0].includes('contém dados pessoais'));
  ok('Depois vem o cabeçalho', matriz[1][0] === 'Nome');
  ok('E uma linha por pessoa inscrita', matriz.length === 4 + 2);
  // No .xlsx os valores vão como NÚMERO, não texto: sem isso não dá para somar
  // a coluna no Excel, que é metade do motivo de exportar.
  const colDevido = matriz[1].indexOf('Valor devido');
  ok('Os valores vão como número, para poderem ser somados no Excel', matriz.slice(2).every(l => typeof l[colDevido] === 'number'));

  await page.evaluate(() => { delete window.XLSX; });
  await page.route('**/xlsx.full.min.js', r => r.abort());
  const [baixadoFallback] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-exportar-xlsx'),
  ]);
  ok('Se a biblioteca de Excel não carrega, o site entrega o CSV em vez de falhar', baixadoFallback.suggestedFilename().endsWith('.csv'));
  await page.unroute('**/xlsx.full.min.js');

  await page.click('#btn-back-admin2');
  await page.waitForTimeout(200);
  await page.click('#btn-back-batuqueiro');
  await page.waitForTimeout(300);

  console.log('\n== 16h2. "Não" escrito de outro jeito ainda tira a pessoa das listas ==');
  // Os dados de quem já usava o site vieram de uma importação, onde o "vai
  // tocar" pode ter sido gravado como "NÃO", "nao" ou com espaço sobrando. Uma
  // comparação exata com "Não" deixava essas pessoas na lista de presença e na
  // conta de camisas como se fossem desfilar.
  for (const variante of ['NÃO', 'nao', ' Não ', 'NAO']) {
    await page.evaluate(async (valor) => {
      const fb = await import('./firebase-init.mock.js');
      const uid = window.__mock.uidPorEmail('duda@example.com');
      await fb.updateDoc(fb.doc(fb.db, 'edicoes', '2027-1', 'inscricoes', uid), { vaiTocar: valor });
    }, variante);
    await page.waitForTimeout(350);
    html = await appHtml(page);
    ok(`Escrito como "${variante}", ela sai da tabela de presença`, !html.includes(`data-uid="${uids.duda}"`));
  }
  await page.evaluate(async () => {
    const fb = await import('./firebase-init.mock.js');
    const uid = window.__mock.uidPorEmail('duda@example.com');
    await fb.updateDoc(fb.doc(fb.db, 'edicoes', '2027-1', 'inscricoes', uid), { vaiTocar: 'Sim' });
  });
  await page.waitForTimeout(350);
  html = await appHtml(page);
  ok('E com "Sim" ela volta para a tabela', html.includes(`data-uid="${uids.duda}"`));

  console.log('\n== 16i. Dados forjados no banco não viram privilégio nem código na tela ==');
  // Estes dois testes cobrem ataques reais de quem tem cadastro no site e sabe
  // consultar o Firestore direto pelo navegador. O mock não aplica as regras de
  // segurança (elas ficam no firestore.rules e são a barreira de verdade), então
  // aqui a checagem é da SEGUNDA camada: mesmo que uma escrita dessas passasse,
  // o site não pode obedecer a ela.
  await page.evaluate(async () => {
    const fb = await import('./firebase-init.mock.js');
    const uid = window.__mock.uidPorEmail('duda@example.com');
    // 1) privilégio forjado na própria inscrição, que a tela funde por cima do cadastro
    await fb.updateDoc(fb.doc(fb.db, 'edicoes', '2027-1', 'inscricoes', uid), {
      adminAccess: true, presencaAccess: true, nome: 'Duda (ADMIN)', email: 'falso@example.com',
    });
    // 2) atributo de evento escondido dentro da data de nascimento
    await fb.setDoc(fb.doc(fb.db, 'contatos', uid), {
      dataNascimento: '" autofocus onfocus="window.__invadiu=1', celular: '(21) 91234-5678',
    }, { merge: true });
  });
  await page.waitForTimeout(400);
  await page.click('#btn-goto-admin');
  await page.waitForTimeout(250);
  await page.click('#btn-goto-pessoas');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Privilégio gravado na inscrição não vira selo de admin na tela', !html.includes('Duda (ADMIN)'));
  const marcadoComoAdmin = await page.evaluate((uid) => {
    const linha = [...document.querySelectorAll('.list-row')].find(l => l.textContent.includes('Duda'));
    return linha ? linha.textContent.includes('Acesso admin') : null;
  }, uids.duda);
  ok('E a linha dela não exibe "Acesso admin"', marcadoComoAdmin === false);
  ok('Nem o e-mail forjado aparece no lugar do verdadeiro', !html.includes('falso@example.com'));

  await page.click(`[data-edit-user="${uids.duda}"]`);
  await page.waitForTimeout(300);
  const invadiu = await page.evaluate(() => window.__invadiu);
  ok('Abrir o cadastro dela no painel não executa código plantado no nascimento', invadiu === undefined);
  const caixaAdmin = await page.locator(`#ae-adminaccess-${uids.duda}`).isChecked();
  ok('A caixa "Acesso ao painel admin" não vem marcada por causa do dado forjado', caixaAdmin === false);
  const anoNoCampo = await page.locator(`#ae-datanasc-${uids.duda}-ano`).inputValue();
  ok('E a data fora de formato é descartada em vez de ir para o HTML', anoNoCampo === '');
  await page.click(`[data-admin-edit-form="${uids.duda}"] button[type=submit]`);
  await page.waitForTimeout(400);
  const depoisDoSalvar = await page.evaluate(() => {
    const uid = window.__mock.uidPorEmail('duda@example.com');
    return window.__mock.dumpStore().pessoas[uid];
  });
  ok('Salvar o formulário não promove ninguém a admin', depoisDoSalvar.adminAccess !== true);
  ok('Nem grava o e-mail forjado no cadastro', depoisDoSalvar.email === 'duda@example.com');
  // limpa o que foi plantado, para o resto da suíte seguir normal
  await page.evaluate(async () => {
    const fb = await import('./firebase-init.mock.js');
    const uid = window.__mock.uidPorEmail('duda@example.com');
    await fb.setDoc(fb.doc(fb.db, 'contatos', uid), { celular: '(21) 98888-0000', dataNascimento: '1996-05-10' });
  });
  await page.waitForTimeout(300);

  console.log('\n== 16j. Nome com fórmula não é executado pelo Excel ==');
  await page.click(`[data-edit-user="${uids.duda}"]`);
  await page.waitForTimeout(250);
  await page.fill(`#ae-apelido-${uids.duda}`, '=HYPERLINK("http://x.tld","clique")');
  await page.click(`[data-admin-edit-form="${uids.duda}"] button[type=submit]`);
  await page.waitForTimeout(400);
  const [baixadoFormula] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-exportar-csv'),
  ]);
  const csvFormula = readFileSync(await baixadoFormula.path(), 'utf8');
  // O apóstrofo à frente obriga a planilha a tratar a célula como texto. Sem
  // ele, a fórmula roda na máquina de quem abrir o arquivo — que é o arquivo com
  // o telefone da bateria inteira.
  ok('Célula que começa com = sai neutralizada no CSV', csvFormula.includes("'=HYPERLINK"));
  ok('E nenhuma célula do arquivo começa com = solto', !/(^|;|\n)=/.test(csvFormula));
  await page.click(`[data-edit-user="${uids.duda}"]`);
  await page.waitForTimeout(250);
  await page.fill(`#ae-apelido-${uids.duda}`, 'Dudinha');
  await page.click(`[data-admin-edit-form="${uids.duda}"] button[type=submit]`);
  await page.waitForTimeout(400);
  await page.click('#btn-back-admin2');
  await page.waitForTimeout(200);
  await page.click('#btn-back-batuqueiro');
  await page.waitForTimeout(300);

  console.log('\n== 16k. Entrar no site não pisca a tela de confirmar inscrição ==');
  // Quem já respondeu tudo via, por cerca de um segundo a cada login, a tela de
  // confirmar inscrição, porque o site decidia "não está inscrito" antes de as
  // inscrições terem chegado. Além de confuso, um clique ali dentro naquele
  // instante reescrevia a inscrição por cima e zerava o pagamento.
  await logout(page);
  await page.evaluate(() => {
    window.__viuFormInscricao = false;
    window.__telas = [];
    const alvo = document.getElementById('app');
    new MutationObserver(() => {
      if (document.getElementById('form-inscricao')) window.__viuFormInscricao = true;
      const h = alvo.innerHTML;
      const tela = document.getElementById('form-inscricao') ? 'inscricao'
        : h.includes('Carregando') ? 'carregando'
        : h.includes('Presença em ensaios') ? 'batuqueiro' : 'outra';
      if (window.__telas[window.__telas.length - 1] !== tela) window.__telas.push(tela);
    }).observe(alvo, { childList: true, subtree: true });
  });
  await login(page, 'ana@example.com');
  await page.waitForTimeout(900);
  const piscou = await page.evaluate(() => window.__viuFormInscricao);
  const telas = await page.evaluate(() => window.__telas);
  ok('A tela de confirmar inscrição não aparece para quem já está inscrito', piscou === false);
  ok('Enquanto os dados chegam, o site diz que está carregando', telas.includes('carregando'));
  ok('E termina na área do batuqueiro', telas[telas.length - 1] === 'batuqueiro');

  console.log('\n== 17. Presença: Ana (admin) marca presença de Duda ==');
  await page.waitForTimeout(150);
  html = await appHtml(page);
  ok('Tabela de presença mostra linha da Duda', html.includes(`data-uid="${uids.duda}"`));
  const toggleCount = await page.locator(`.toggle[data-uid="${uids.duda}"]`).count();
  ok('Existe pelo menos um toggle de presença para Duda', toggleCount > 0);
  if (toggleCount > 0) {
    await page.locator(`.toggle[data-uid="${uids.duda}"]`).first().click();
    await page.waitForTimeout(350);
    // re-consulta o DOM (render() substitui os elementos após o clique, então o
    // handle antigo fica desconectado — precisa buscar de novo, não reusar).
    const cls = await page.locator(`.toggle[data-uid="${uids.duda}"]`).first().getAttribute('class');
    ok('Toggle de presença da Duda virou "on" após clique de Ana', cls.includes('on'));
  }

  console.log('\n== 18. Linha de total de presentes por ensaio, no rodapé da tabela ==');
  html = await appHtml(page);
  ok('Aparece a linha "Total presentes"', html.includes('Total presentes'));
  ok('Total do ensaio marcado mostra 1 presente de 4 pessoas', html.includes('1/4'));
  ok('Mostra quantas pessoas estão no filtro atual (4, sem filtro)', html.includes('4 pessoas no filtro'));

  console.log('\n== 19. Filtro de presença por posição ==');
  await page.selectOption('#presenca-filtro-posicao', 'Repique');
  await page.waitForTimeout(200);
  html = await appHtml(page);
  ok('Filtro por posição (Repique) mostra só Duda', html.includes('Duda Reis') && !html.includes('Bruno Costa'));
  ok('Total recalcula com o filtro: 1 de 1 pessoa', html.includes('1/1'));
  ok('Contagem de pessoas no filtro atualiza para 1', html.includes('1 pessoa no filtro'));
  await page.selectOption('#presenca-filtro-posicao', 'todas');
  await page.waitForTimeout(150);

  console.log('\n== 20. Repertório visível para o batuqueiro, com o ensaio em que foi tocada ==');
  html = await appHtml(page);
  ok('Batuqueiro vê a tabela de repertório da edição', html.includes('<h2>Repertório</h2>'));
  ok('Repertório mostra a música com tom e cantor(a)', html.includes('Ventania') && html.includes('Sol maior'));
  await logout(page);

  console.log('\n== 21. Duda vê a presença, mas só como leitura (sem acesso de edição) ==');
  await login(page, 'duda@example.com');
  html = await appHtml(page);
  ok('Duda NÃO vê nenhum toggle clicável', !html.includes('class="toggle'));
  ok('Presença marcada por Ana aparece como badge "Presente" (somente leitura)', html.includes('badge-good">Presente<'));
  ok('Texto do card avisa que é só visualização', html.includes('Veja a presença de todos os batuqueiros'));
  await logout(page);

  console.log('\n== 22. Admin concede acesso de edição de presença a quem não é admin (Carla) ==');
  await login(page, 'bruno@example.com');
  await page.click('#btn-goto-admin');
  await page.click('#btn-goto-pessoas');
  await page.waitForTimeout(200);
  await page.click(`[data-edit-user="${uids.carla}"]`);
  await page.waitForTimeout(200);
  await page.check(`#ae-presencaaccess-${uids.carla}`);
  await page.click(`[data-admin-edit-form="${uids.carla}"] button[type=submit]`);
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Carla aparece na lista com o badge "Edita presença"', html.includes('Edita presença'));
  await logout(page);

  await login(page, 'carla@example.com');
  html = await appHtml(page);
  ok('Carla (não-admin, com presencaAccess) vê os botões SIM/NÃO', html.includes('class="toggle'));
  await page.locator(`.toggle[data-uid="${uids.duda}"]`).first().click();
  await page.waitForTimeout(350);
  const clsCarla = await page.locator(`.toggle[data-uid="${uids.duda}"]`).first().getAttribute('class');
  ok('Carla consegue alterar a presença da Duda', clsCarla.includes('off'));
  await logout(page);

  // ============================================================
  console.log('\n== 23. Criar o carnaval seguinte (2028) copiando posições e valores ==');
  await login(page, 'bruno@example.com');
  await page.click('#btn-goto-admin');
  await page.waitForTimeout(150);
  await page.click('#btn-goto-edicoes');
  await page.waitForTimeout(200);
  await page.click('#btn-toggle-nova-edicao');
  await page.waitForTimeout(150);
  await page.fill('#nova-edicao-ano', '2028');
  await page.fill('#nova-edicao-nome', 'Carnaval do Fogo e Paixão 2028');
  await fillDataEmTresCampos(page, 'nova-edicao-data', '2028-02-22');
  await page.check('#nova-edicao-copiar');
  await page.click('#btn-criar-edicao');
  await page.waitForTimeout(400);
  html = await appHtml(page);
  ok('Segunda edição criada como 2028-1', html.includes('(2028-1)'));
  ok('2027 continua Aberta e 2028 nasce Em preparação', html.includes('Em preparação') && html.includes('>Aberta<'));

  await page.click('#btn-back-admin7');
  await page.waitForTimeout(250);
  html = await appHtml(page);
  ok('Posições foram copiadas para a edição nova (não precisa recadastrar)', html.includes('18 posições'));
  ok('Valores da anuidade também vieram copiados', html.includes('R$&nbsp;210,00') || html.includes('210,00'));
  ok('A edição nova começa sem ninguém inscrito', html.includes('0 pessoas vão desfilar neste carnaval'));
  ok('A edição nova começa sem ensaios', html.includes('0 de 0 ensaios já realizados'));
  ok('A edição nova começa sem repertório (dados de 2027 não vazam)', html.includes('0 músicas cadastradas'));

  console.log('\n== 24. Abrir 2028 encerra 2027 automaticamente ==');
  await page.click('#btn-goto-edicoes');
  await page.waitForTimeout(200);
  await page.click('[data-abrir-edicao="2028-1"]');
  await page.waitForTimeout(500);
  html = await appHtml(page);
  ok('2027 passou a Encerrada sozinha ao abrir 2028', html.includes('Encerrada'));
  const abertas = (html.match(/>Aberta</g) || []).length;
  ok('Existe no máximo uma edição aberta por vez', abertas === 1);
  await logout(page);

  console.log('\n== 25. Ana renova a inscrição em 2028 com os dados de 2027 pré-preenchidos ==');
  await login(page, 'ana@example.com');
  await page.waitForSelector('#form-inscricao', { timeout: 5000 });
  await page.waitForTimeout(400);
  html = await appHtml(page);
  ok('Aparece a tela de confirmar inscrição no carnaval novo', html.includes('Confirmar inscrição — Carnaval do Fogo e Paixão 2028'));
  ok('O formulário avisa que veio pré-preenchido com o carnaval anterior', html.includes('seus dados do Carnaval do Fogo e Paixão 2027'));
  const posicaoPreSelecionada = await page.locator('#insc-posicao').inputValue();
  ok('Posição de 2027 (Surdo 1) vem pré-selecionada', posicaoPreSelecionada === 'Surdo 1');
  const camisaPre = await page.locator('#insc-radio-camisa .radio-pill.active').getAttribute('data-val');
  ok('Camisa de 2027 (M) vem pré-selecionada', camisaPre === 'M');

  // Regressão: o formulário de inscrição não pode perder o que já foi escolhido se
  // a tela for redesenhada no meio (dados chegando em tempo real de outra pessoa).
  await page.selectOption('#insc-posicao', 'Caixa');
  await page.evaluate(async () => {
    const fb = await import('./firebase-init.mock.js');
    const ref = await fb.addDoc(fb.collection(fb.db, 'edicoes', '2028-1', 'ensaios'), { data: '2030-04-04' });
    await fb.deleteDoc(fb.doc(fb.db, 'edicoes', '2028-1', 'ensaios', ref.id));
  });
  await page.waitForTimeout(250);
  ok('Escolha de posição não salva sobrevive a um re-render em segundo plano', (await page.locator('#insc-posicao').inputValue()) === 'Caixa');

  // Ana muda de instrumento e de camisa neste carnaval — o que muda, muda só aqui.
  await confirmarInscricao(page, { posicao: 'Caixa', camisa: 'G' });
  html = await appHtml(page);
  ok('Depois de confirmar, entra na área do batuqueiro de 2028', html.includes('Carnaval do Fogo e Paixão 2028'));
  ok('Nova posição (Caixa) vale para 2028', html.includes('Caixa'));
  ok('Pagamento de 2028 começa do zero, sem herdar o de 2027', html.includes('plan-picker'));
  ok('Data de nascimento (dado permanente) continua a mesma', html.includes('05/11/1980'));

  console.log('\n== 26. Histórico do batuqueiro com os dois carnavais ==');
  await page.click('#btn-goto-historico');
  await page.waitForTimeout(700);
  html = await appHtml(page);
  ok('Histórico lista o carnaval de 2027', html.includes('Carnaval do Fogo e Paixão 2027'));
  ok('Histórico lista o carnaval de 2028', html.includes('Carnaval do Fogo e Paixão 2028'));
  ok('Histórico mostra a posição de cada ano (Surdo 1 em 2027, Caixa em 2028)', html.includes('Surdo 1') && html.includes('Caixa'));
  ok('Histórico mostra a data de cada desfile', html.includes('09/02/2027') && html.includes('22/02/2028'));
  ok('Histórico mostra a presença nos ensaios de 2027', html.includes('de 3 ensaios'));
  await logout(page);

  console.log('\n== 26a. Texto digitado com aspas e sinais de HTML não quebra a tela ==');
  // Regressão: as telas são montadas com template strings + innerHTML. Sem escapar,
  // uma aspa dupla encerra o atributo value do campo e um "<" é interpretado como
  // marcação — o que quebraria a página inteira com um nome perfeitamente normal.
  await login(page, 'bruno@example.com');
  await page.click('#btn-goto-admin');
  await page.waitForTimeout(200);
  await page.click('#btn-goto-musicas');
  await page.waitForTimeout(250);
  const NOME_ARRISCADO = 'Vem Ni Mim "2" <b>teste</b>';
  await page.fill('#new-musica-nome', NOME_ARRISCADO);
  await page.fill('#new-musica-tom', 'Sol "maior"');
  await page.click('#btn-add-musica');
  await page.waitForTimeout(300);
  const valorNoCampo = await page.locator(`.musica-name-input[value]`).evaluateAll(els => els.map(e => e.value));
  ok('Nome com aspas e < > é guardado e relido inteiro no campo', valorNoCampo.includes(NOME_ARRISCADO));
  ok('O <b> não virou marcação de verdade na página', (await page.locator('#hist-pessoas-tbody, .card b:has-text("teste")').count()) === 0);
  const tomNoCampo = await page.locator('.musica-tom-input').evaluateAll(els => els.map(e => e.value));
  ok('Tom com aspas também sobrevive', tomNoCampo.includes('Sol "maior"'));
  // remove para não interferir nas contagens dos testes seguintes
  await page.click(`[data-remove-musica]:below(:text("${'Vem Ni Mim'}"))`).catch(async () => {
    const idx = valorNoCampo.indexOf(NOME_ARRISCADO);
    await page.locator('[data-remove-musica]').nth(idx).click();
  });
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Música com caracteres especiais pôde ser removida normalmente', !html.includes('teste&lt;/b&gt;') || !html.includes(NOME_ARRISCADO));
  await page.click('#btn-back-admin6');
  await page.waitForTimeout(200);
  await logout(page);

  console.log('\n== 26b. Carla se inscreve em 2028, mas avisa que NÃO vai tocar ==');
  await login(page, 'carla@example.com');
  await page.waitForSelector('#form-inscricao', { timeout: 5000 });
  await page.waitForTimeout(500);
  // Regressão: o rascunho pré-preenchido tem que ser o DELA, não o de quem usou o
  // navegador antes (a Ana acabou de passar por esta mesma tela nesta sessão).
  const camisaCarla = await page.locator('#insc-radio-camisa .radio-pill.active').getAttribute('data-val');
  ok('Pré-preenchimento é o da Carla (camisa P de 2027), não o de quem logou antes', camisaCarla === 'P');
  await confirmarInscricao(page, { vaiTocar: 'Não' });
  html = await appHtml(page);
  ok('Quem se inscreve sem ir tocar entra normalmente na área do batuqueiro', html.includes('Presença em ensaios'));
  const inscCarla = await page.evaluate(() => {
    const uid = window.__mock.uidPorEmail('carla@example.com');
    return window.__mock.dumpStore()['edicoes/2028-1/inscricoes'][uid];
  });
  ok('O "não vou tocar" fica gravado na inscrição de 2028', inscCarla && inscCarla.vaiTocar === 'Não');
  ok('A posição dela de 2027 foi mantida na renovação', inscCarla && inscCarla.posicao === 'Voz');
  await logout(page);

  console.log('\n== 26c. Histórico geral do admin: batuqueiros e músicas cruzando todos os carnavais ==');
  await login(page, 'bruno@example.com');
  await page.click('#btn-goto-admin');
  await page.waitForTimeout(200);
  await page.click('#btn-goto-historico-geral');
  await page.waitForTimeout(1200);
  html = await appHtml(page);
  ok('Tela do histórico geral tem as duas tabelas', html.includes('Batuqueiros por carnaval') && html.includes('Músicas por carnaval'));
  const colunas = await page.$$eval('#hist-pessoas-table thead th', els => els.map(e => e.textContent.trim()));
  ok('Colunas trazem os dois carnavais, do mais antigo para o mais novo', colunas[1].includes('2027') && colunas[2].includes('2028'));
  ok('Cabeçalho da coluna mostra também a data do desfile', colunas[1].includes('09/02/2027'));

  // Ana tocou nos dois anos, com posições diferentes; Duda só em 2027.
  const linhaAna = await page.locator('#hist-pessoas-tbody tr[data-hist-nome*="ana silva"]').innerHTML();
  ok('Ana aparece com a posição de 2027 (Surdo 1) e a de 2028 (Caixa)', linhaAna.includes('Surdo 1') && linhaAna.includes('Caixa'));
  const linhaDuda = await page.locator('#hist-pessoas-tbody tr[data-hist-nome*="duda reis"]').innerHTML();
  ok('Duda tocou em 2027', linhaDuda.includes('Repique'));
  ok('Duda não tem inscrição em 2028 (célula vazia, não "não tocou")', linhaDuda.includes('—'));
  // Os três estados possíveis da célula precisam ser distinguíveis entre si.
  const linhaCarla = await page.locator('#hist-pessoas-tbody tr[data-hist-nome*="carla dias"]').innerHTML();
  ok('Carla, inscrita em 2028 mas que não vai tocar, aparece como "Não tocou"', linhaCarla.includes('Não tocou'));
  ok('"Não tocou" (inscrito) é visualmente diferente de "—" (sem inscrição)', linhaCarla.includes('badge-warning') && linhaDuda.includes('<span class="hint">—'));
  ok('Carla conta 1 carnaval tocado (2027), não 2', (await page.locator('#hist-pessoas-tbody tr[data-hist-nome*="carla dias"] .hist-total-pessoa').textContent()) === '1');
  ok('Coluna "Carnavais" conta em quantos a pessoa tocou', (await page.locator('#hist-pessoas-tbody tr[data-hist-nome*="ana silva"] .hist-total-pessoa').textContent()) === '2');

  const linhaMusica = await page.locator('#hist-musicas-tbody tr[data-hist-nome*="ventania"]').innerHTML();
  ok('Música ensaiada em 2027 mostra em quantos ensaios foi tocada', linhaMusica.includes('1 ensaio'));
  ok('Música que não existe no repertório de 2028 aparece vazia naquele ano', linhaMusica.includes('—'));
  const linhaAquarela = await page.locator('#hist-musicas-tbody tr[data-hist-nome*="aquarela (editada)"]').innerHTML();
  ok('Música cadastrada mas nunca ensaiada aparece como "No repertório"', linhaAquarela.includes('No repertório'));

  console.log('\n== 26d. Filtro do histórico geral (sem perder o foco do campo) ==');
  const rodapeAntes = await page.locator('.hist-rodape-pessoas').first().textContent();
  ok('Rodapé mostra quantos tocaram em 2027 antes do filtro (4)', rodapeAntes === '4');
  await page.fill('#hist-filtro', 'ana');
  await page.waitForTimeout(250);
  const focoDepois = await page.evaluate(() => document.activeElement && document.activeElement.id);
  ok('Campo de busca mantém o foco enquanto se digita', focoDepois === 'hist-filtro');
  const visiveis = await page.locator('#hist-pessoas-tbody tr[data-hist-nome]:visible').count();
  ok('Filtro deixa só a Ana na tabela de batuqueiros', visiveis === 1);
  const rodapeDepois = await page.locator('.hist-rodape-pessoas').first().textContent();
  ok('Rodapé recalcula com o filtro aplicado (1)', rodapeDepois === '1');
  await page.fill('#hist-filtro', 'dudinha');
  await page.waitForTimeout(250);
  ok('A busca também encontra a pessoa pelo apelido', (await page.locator('#hist-pessoas-tbody tr[data-hist-nome]:visible').count()) === 1);
  await page.fill('#hist-filtro', '');
  await page.waitForTimeout(250);
  ok('Limpar o filtro traz todo mundo de volta', (await page.locator('#hist-pessoas-tbody tr[data-hist-nome]:visible').count()) === 4);
  await page.click('#btn-back-admin8');
  await page.waitForTimeout(200);
  await logout(page);

  console.log('\n== 27. Edição encerrada vira histórico só-leitura, até para o admin ==');
  await login(page, 'bruno@example.com');
  await page.click('#btn-goto-admin');
  await page.waitForTimeout(200);
  await page.selectOption('#admin-troca-edicao', '2027-1');
  await page.waitForTimeout(400);
  html = await appHtml(page);
  ok('Admin consegue voltar a visualizar a edição encerrada de 2027', html.includes('Carnaval do Fogo e Paixão 2027'));
  ok('Os dados de 2027 continuam lá (4 inscritos)', html.includes('4 pessoas vão desfilar neste carnaval'));

  await page.click('#btn-goto-ensaios');
  await page.waitForTimeout(250);
  html = await appHtml(page);
  ok('Na edição encerrada, os ensaios ficam só leitura', html.includes('só leitura') && !html.includes('data-remove-ensaio'));
  ok('Na edição encerrada, não dá para adicionar ensaio', !html.includes('btn-add-ensaio'));
  ok('Aviso de que a edição não está em andamento aparece no topo', html.includes('Você está vendo dados de um carnaval que não está em andamento'));

  await page.click('#btn-back-admin4');
  await page.waitForTimeout(200);
  await page.click('#btn-goto-posicoes');
  await page.waitForTimeout(250);
  html = await appHtml(page);
  ok('Na edição encerrada, as posições ficam só leitura', !html.includes('btn-save-all-posicoes'));
  await page.click('#btn-back-admin');
  await page.waitForTimeout(200);

  console.log('\n== 28. Reabrir a edição encerrada para corrigir algo ==');
  await page.click('#btn-goto-edicoes');
  await page.waitForTimeout(250);
  await page.click('[data-reabrir-edicao="2027-1"]');
  await page.waitForTimeout(400);
  html = await appHtml(page);
  ok('2027 volta para "Em preparação" ao ser reaberta', html.includes('Em preparação'));
  ok('2028 continua sendo a edição aberta', html.includes('>Aberta<'));
  await logout(page);

  // ============================================================
  console.log('\n== 29. Importação dos dados do formato antigo (migração única) ==');
  await page.evaluate(() => window.__mock.reset());
  await page.reload();
  await page.waitForSelector('#btn-goto-register');
  await registrar(page, { email: 'pedro@example.com', nome: 'Pedro', sobrenome: 'Martins', comEdicaoAberta: false });
  await logout(page);

  // Reproduz fielmente a situação real: a pessoa só existe no formato ANTIGO.
  // Apaga o cadastro novo criado acima e monta o banco como era antes — inclusive
  // o acesso de admin, que ficava em /users e não em /pessoas.
  await page.evaluate(async () => {
    const uid = window.__mock.uidPorEmail('pedro@example.com');
    const fb = await import('./firebase-init.mock.js');
    await fb.deleteDoc(fb.doc(fb.db, 'pessoas', uid));
  });
  await page.evaluate(() => {
    const uid = window.__mock.uidPorEmail('pedro@example.com');
    window.__mock.seedFormatoAntigo({
      users: {
        [uid]: {
          nome: 'Pedro', sobrenome: 'Martins', email: 'pedro@example.com', celular: '(21) 90000-0000',
          dataNascimento: '1979-01-12', vaiTocar: 'Sim', posicao: 'Tamborim', camisa: 'M',
          isentoManual: false, formaPagamento: 'avista', totalPago: 210, adminAccess: true, presencaAccess: false,
        },
        legado2: {
          nome: 'Fred', sobrenome: 'Lima', email: 'fred@example.com', celular: '(21) 91111-1111',
          dataNascimento: '1985-07-20', vaiTocar: 'Sim', posicao: 'Caixa', camisa: 'G',
          isentoManual: false, formaPagamento: null, totalPago: 0, adminAccess: false, presencaAccess: true,
        },
      },
      posicoes: { pos1: { nome: 'Tamborim', isenta: false }, pos2: { nome: 'Caixa', isenta: false } },
      ensaios: { ens1: { data: '2025-11-05' }, ens2: { data: '2025-11-12' } },
      musicas: { mus1: { nome: 'Alvorada', tom: 'Ré maior', cantor: 'Fred' } },
      'config': { precos: { avista: { valor: 210, prazos: ['2026-12-01'] }, duasVezes: { valor: 230, prazos: ['', ''] }, tresVezes: { valor: 250, prazos: ['', '', ''] } } },
      presencas: { 'ens1_legado2': { ensaioId: 'ens1', uid: 'legado2', presente: true } },
    });
  });
  // Caso real: ao entrar no site novo antes de importar, a pessoa foi levada à
  // tela de "criar cadastro" e refez o cadastro — ficando com um registro novo
  // SEM acesso admin, em paralelo ao registro antigo que tem o acesso.
  await page.evaluate(async () => {
    const uid = window.__mock.uidPorEmail('pedro@example.com');
    const fb = await import('./firebase-init.mock.js');
    await fb.setDoc(fb.doc(fb.db, 'pessoas', uid), {
      nome: 'Pedro', sobrenome: 'Martins', email: 'pedro@example.com',
      celular: '(21) 90000-0000', dataNascimento: '2000-01-01',
      adminAccess: false, presencaAccess: false,
    });
  });

  respostaPrompt = '2027';
  await login(page, 'pedro@example.com');
  await page.waitForTimeout(400);
  html = await appHtml(page);
  ok('Mesmo com um cadastro novo sem admin, o acesso do formato antigo vale', html.includes('Painel admin'));
  // Regressão do que aconteceu em produção: quem já era admin no formato antigo
  // entrava no site novo sem o botão do painel — justamente quem precisa dele
  // para rodar a importação — e via só "inscrições fechadas".
  ok('Admin do formato antigo é reconhecido como admin no site novo', html.includes('Painel admin'));
  ok('Em vez de "inscrições fechadas", ele vê o aviso de importação pendente', html.includes('Seus dados ainda estão no formato antigo'));
  ok('E o botão de importar está logo ali', html.includes('btn-migrar-legado'));

  await page.click('#btn-goto-admin');
  await page.waitForTimeout(250);
  html = await appHtml(page);
  ok('Antes de migrar, o painel avisa que não há edição cadastrada', html.includes('Nenhuma edição do carnaval cadastrada ainda'));
  ok('O painel também destaca que há dados antigos esperando importação', html.includes('Encontrei dados no formato antigo esperando importação'));
  await page.click('#btn-migrar-legado');
  await page.waitForTimeout(900);
  html = await appHtml(page);
  ok('Depois de importar, existe uma edição 2027 com os dados antigos', html.includes('Carnaval do Fogo e Paixão 2027'));
  const contatosImportados = await page.evaluate(() => {
    const s = window.__mock.dumpStore();
    const uid = window.__mock.uidPorEmail('pedro@example.com');
    return { contato: (s.contatos || {})[uid], pessoa: s.pessoas[uid], fred: (s.contatos || {}).legado2 };
  });
  ok('A importação já traz o contato para a área restrita', contatosImportados.contato.celular === '(21) 90000-0000');
  ok('E não deixa cópia no cadastro que todos leem', !(contatosImportados.pessoa.celular || '').trim());
  ok('Vale para quem nunca entrou no site novo também (Fred)', contatosImportados.fred.celular === '(21) 91111-1111');
  ok('Os 2 cadastros antigos viraram inscrições da edição', html.includes('2 pessoas vão desfilar neste carnaval'));
  ok('Os ensaios antigos foram importados', html.includes('2 de 2 ensaios já realizados'));
  ok('As posições antigas foram importadas', html.includes('2 posições cadastradas'));
  ok('O repertório antigo foi importado', html.includes('1 música cadastrada'));
  ok('Os valores da anuidade antigos foram importados', html.includes('210,00'));
  ok('O total já pago foi preservado (R$ 210 arrecadados)', html.includes('210,00'));

  console.log('\n== 29b. A importação não pode ser rodada duas vezes ==');
  // As coleções antigas continuam existindo depois de importar, então "ainda há
  // dados antigos" não serve de guarda. Sem o bloqueio, um segundo clique criava
  // uma edição duplicada, sobrescrevia os cadastros com os dados antigos —
  // rebaixando quem tivesse virado admin depois — e deixava dois carnavais abertos.
  const edicoesAntes = await page.evaluate(() => Object.keys(window.__mock.dumpStore().edicoes || {}).length);
  await page.click('#btn-goto-edicoes');
  await page.waitForTimeout(250);
  await page.click('#btn-migrar-legado');
  await page.waitForTimeout(600);
  const edicoesDepois = await page.evaluate(() => Object.keys(window.__mock.dumpStore().edicoes || {}).length);
  ok('Rodar a importação de novo não cria uma segunda edição', edicoesDepois === edicoesAntes);
  const abertasAposImportar = await page.evaluate(() => Object.values(window.__mock.dumpStore().edicoes || {}).filter(e => e.status === 'aberta').length);
  ok('Continua havendo no máximo um carnaval aberto', abertasAposImportar === 1);
  // Um acesso concedido DEPOIS da importação não pode ser desfeito por ela.
  await page.evaluate(async () => {
    const fb = await import('./firebase-init.mock.js');
    const uid = window.__mock.uidPorEmail('pedro@example.com');
    await fb.updateDoc(fb.doc(fb.db, 'pessoas', uid), { apelido: 'Pedrão' });
  });
  await page.waitForTimeout(250);
  await page.click('#btn-migrar-legado');
  await page.waitForTimeout(600);
  const apelidoDepois = await page.evaluate(() => {
    const uid = window.__mock.uidPorEmail('pedro@example.com');
    return window.__mock.dumpStore().pessoas[uid].apelido;
  });
  ok('Mudanças feitas depois da importação não são desfeitas por um novo clique', apelidoDepois === 'Pedrão');

  // Com o carnaval importado ENCERRADO, a barreira de "já existe um aberto" não
  // vale mais — o que segura é a marca de importação na própria edição. Sem ela,
  // um clique aqui recriaria tudo numa edição nova.
  await page.click('[data-encerrar-edicao="2027-1"]');
  await page.waitForTimeout(400);
  await page.click('#btn-migrar-legado');
  await page.waitForTimeout(600);
  const edicoesAposEncerrar = await page.evaluate(() => Object.keys(window.__mock.dumpStore().edicoes || {}).length);
  ok('Mesmo sem carnaval aberto, a importação segue bloqueada por já ter sido feita', edicoesAposEncerrar === edicoesAntes);
  const apelidoFinal = await page.evaluate(() => {
    const uid = window.__mock.uidPorEmail('pedro@example.com');
    return window.__mock.dumpStore().pessoas[uid].apelido;
  });
  ok('E os cadastros continuam intactos', apelidoFinal === 'Pedrão');
  // devolve a edição ao ar para o restante da checagem: encerrada → reabrir
  // (volta a "em preparação") → abrir para os batuqueiros
  await page.click('[data-reabrir-edicao="2027-1"]');
  await page.waitForTimeout(400);
  await page.click('[data-abrir-edicao="2027-1"]');
  await page.waitForTimeout(400);
  await page.click('#btn-back-admin7');
  await page.waitForTimeout(250);

  await page.click('#btn-back-batuqueiro');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Pedro entra direto na área do batuqueiro (inscrição criada na migração)', html.includes('Presença em ensaios'));
  ok('Dados permanentes de Pedro preservados (nascimento 12/01/1979)', html.includes('12/01/1979'));
  ok('Dados do carnaval preservados (posição Tamborim)', html.includes('Tamborim'));
  ok('Presença antiga do Fred foi importada junto', html.includes('Fred Lima'));

  console.log('\n== 29c. Separar contatos que já estavam no cadastro de leitura geral ==');
  // Situação real do site em produção: os cadastros foram criados quando celular
  // e nascimento ainda ficavam dentro de /pessoas. O painel avisa e oferece um
  // botão que move esses campos para /contatos sem apagar nada.
  await page.evaluate(async () => {
    const fb = await import('./firebase-init.mock.js');
    const uid = window.__mock.uidPorEmail('pedro@example.com');
    // estado anterior à separação: o contato existe SÓ dentro de /pessoas
    await fb.deleteDoc(fb.doc(fb.db, 'contatos', uid));
    await fb.deleteDoc(fb.doc(fb.db, 'contatos', 'legado2'));
    await fb.updateDoc(fb.doc(fb.db, 'pessoas', uid), { celular: '(21) 97777-1111', dataNascimento: '1979-01-12' });
    await fb.updateDoc(fb.doc(fb.db, 'pessoas', 'legado2'), { celular: '(21) 96666-2222' });
  });
  await page.waitForTimeout(300);
  await page.click('#btn-goto-admin');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('O painel avisa que há contato em área de leitura geral', html.includes('em área de leitura geral'));
  ok('E diz quantos cadastros estão nessa situação', html.includes('de 2 cadastros'));
  await page.click('#btn-separar-contatos');
  await page.waitForTimeout(700);
  const aposSeparar = await page.evaluate(() => {
    const s = window.__mock.dumpStore();
    const uid = window.__mock.uidPorEmail('pedro@example.com');
    return {
      pessoa: s.pessoas[uid], contato: (s.contatos || {})[uid],
      fredPessoa: s.pessoas.legado2, fredContato: (s.contatos || {}).legado2,
      nome: s.pessoas[uid].nome, apelido: s.pessoas[uid].apelido,
    };
  });
  ok('O celular saiu do cadastro que todos leem', !(aposSeparar.pessoa.celular || '').trim());
  ok('E foi parar na área restrita', aposSeparar.contato.celular === '(21) 97777-1111');
  ok('A data de nascimento seguiu junto', aposSeparar.contato.dataNascimento === '1979-01-12');
  ok('Vale para todos os cadastros de uma vez', aposSeparar.fredContato.celular === '(21) 96666-2222' && !(aposSeparar.fredPessoa.celular || '').trim());
  // O maior risco da operação era um set sem merge zerando o cadastro inteiro.
  ok('Nada mais do cadastro foi perdido no caminho', aposSeparar.nome === 'Pedro' && aposSeparar.apelido === 'Pedrão');
  html = await appHtml(page);
  ok('Feita a separação, o aviso some do painel', !html.includes('em área de leitura geral'));
  await page.click('#btn-back-batuqueiro');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('E o contato continua aparecendo normalmente para o dono', html.includes('97777-1111'));

  await logout(page);

  console.log(`\n=== RESULTADO: ${pass} passaram, ${fail} falharam ===`);
  if (fail) { failures.forEach(f => console.log('  - ' + f)); }
  await browser.close();
  process.exitCode = fail ? 1 : 0;
}

main().catch(err => { console.error(err); process.exit(1); });
