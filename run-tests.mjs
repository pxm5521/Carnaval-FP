// Teste automatizado (Playwright) rodando contra test.html + firebase-init.mock.js.
// Cobre: cadastro em 2 etapas + verificação de e-mail obrigatória, login/logout,
// edição de "meus dados", seed de posições/preços padrão, escolha de plano de
// pagamento + registro de pagamento (increment de totalPago via writeBatch),
// isenção automática por posição, presença marcada por OUTRO usuário logado,
// e todas as subviews do admin (posições, preços, ensaios, relatório, pessoas +
// conceder acesso admin a outra pessoa).
import { chromium } from 'playwright';

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

async function registerAndVerify(page, { email, nome, sobrenome, posicao, posicaoOutro, camisa, dataNascimento = '1996-05-10', celular = '(21) 90000-0000' }) {
  await page.click('#btn-goto-register');
  await page.waitForSelector('#form-register1');
  await page.fill('#reg-email', email);
  await page.fill('#reg-senha', 'senha123');
  await page.fill('#reg-senha2', 'senha123');
  await page.click('#form-register1 button[type=submit]');
  await page.waitForSelector('#form-register2', { timeout: 5000 });
  await page.fill('#c-nome', nome);
  await page.fill('#c-sobrenome', sobrenome);
  await page.fill('#c-celular', celular);
  await page.fill('#c-datanasc', dataNascimento);
  await page.click('#radio-vaitocar .radio-pill[data-val="Sim"]');
  await page.selectOption('#c-posicao', posicao);
  if (posicao === 'Outro' && posicaoOutro) await page.fill('#c-posicao-outro', posicaoOutro);
  await page.click(`#radio-camisa .radio-pill[data-val="${camisa}"]`);
  await page.click('#form-register2 button[type=submit]');
  await page.waitForTimeout(200);
  await page.evaluate((e) => window.__mock.verifyEmail(e), email);
  // A mutação do mock já dispara onAuthStateChanged e re-renderiza sozinha
  // (diferente do Firebase real, que exige reload() + clique); só clica se
  // a tela de confirmação ainda estiver visível.
  const stillOnVerify = await page.$('#btn-check-verified');
  if (stillOnVerify) { await stillOnVerify.click(); }
  await page.waitForSelector('#btn-logout', { timeout: 5000 });
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

  await page.goto(BASE);
  await page.waitForSelector('#btn-goto-register');

  // ============================================================
  // Ordem realista: quem cria a conta primeiro (organizador) ainda não tem
  // nenhuma posição cadastrada no sistema (dropdown só tem "Outro") — por
  // isso ele se cadastra com "Outro", vira admin (bootstrap manual único,
  // documentado no SETUP.md) e carrega os padrões antes de convidar o resto.
  console.log('\n== 1. Cadastro do organizador (Bruno) — sem posições ainda, usa "Outro" ==');
  await registerAndVerify(page, { email: 'bruno@example.com', nome: 'Bruno', sobrenome: 'Costa', posicao: 'Outro', posicaoOutro: 'Organização', camisa: 'G' });
  let html = await appHtml(page);
  ok('Após confirmar e-mail, entra na área do batuqueiro', html.includes('Área do Batuqueiro'));
  ok('Sem preços configurados, mostra aviso ao invés de formulário de plano', html.includes('ainda não configurou os valores'));
  await logout(page);

  console.log('\n== 2. Bootstrap do primeiro admin (Bruno) — passo único documentado no SETUP.md ==');
  await page.evaluate(() => window.__mock.grantAdminAccessByEmail('bruno@example.com'));
  await login(page, 'bruno@example.com');
  html = await appHtml(page);
  ok('Bruno agora vê o botão "Painel admin"', html.includes('Painel admin'));
  await page.click('#btn-goto-admin');
  await page.waitForTimeout(150);
  html = await appHtml(page);
  ok('Entra no painel admin', html.includes('Cadastros') && html.includes('Relatório geral'));
  ok('Mostra aviso de primeiro acesso (seed) pois posições/preços ainda não existem', html.includes('Primeiro acesso'));

  console.log('\n== 3. Seed de posições e valores padrão ==');
  await page.click('#btn-seed-defaults');
  await page.waitForTimeout(250);
  html = await appHtml(page);
  ok('Aviso de seed some após carregar padrões', !html.includes('Primeiro acesso'));
  ok('Resumo de posições mostra 17 posições, 8 isentas automaticamente', html.includes('17 posições') && html.includes('8 isentas'));
  await logout(page);

  console.log('\n== 4. Cadastro (Ana) + verificação de e-mail obrigatória, já com posições disponíveis ==');
  await registerAndVerify(page, { email: 'ana@example.com', nome: 'Ana', sobrenome: 'Silva', posicao: 'Surdo 1', camisa: 'M', dataNascimento: '1998-03-15' });
  html = await appHtml(page);
  ok('Nome aparece no cabeçalho', html.includes('Bem-vindo(a), Ana'));
  ok('Sem acesso admin, botão painel admin não aparece', !html.includes('Painel admin'));

  console.log('\n== 5. Editar meus dados ==');
  await page.click('#btn-edit-data');
  await page.fill('#e-datanasc', '1990-01-20');
  await page.click('#form-edit-mydata button[type=submit]');
  await page.waitForTimeout(250);
  html = await appHtml(page);
  ok('Data de nascimento atualizada (20/01/1990)', html.includes('20/01/1990'));

  await logout(page);

  // ============================================================
  console.log('\n== 6. Cadastro de mais 2 pessoas (Carla-Voz, Duda) ==');
  await registerAndVerify(page, { email: 'carla@example.com', nome: 'Carla', sobrenome: 'Dias', posicao: 'Voz', camisa: 'P' });
  await logout(page);
  await registerAndVerify(page, { email: 'duda@example.com', nome: 'Duda', sobrenome: 'Reis', posicao: 'Repique', camisa: 'GG' });
  await logout(page);

  await login(page, 'bruno@example.com');
  await page.click('#btn-goto-admin');
  await page.waitForTimeout(150);

  console.log('\n== 7. Painel admin — Posições (editar isenção, adicionar nova) ==');
  await page.click('#btn-goto-posicoes');
  await page.waitForTimeout(150);
  html = await appHtml(page);
  ok('Lista de posições carregada (Agogô presente)', html.includes('value="Agogô"'));
  await page.fill('#new-posicao-nome', 'Bateria Extra');
  await page.click('#btn-add-posicao');
  await page.waitForTimeout(200);
  html = await appHtml(page);
  ok('Nova posição "Bateria Extra" adicionada', html.includes('Bateria Extra'));
  await page.click('#btn-back-admin');
  await page.waitForTimeout(150);

  console.log('\n== 7. Painel admin — Preços e prazos (definir e salvar) ==');
  await page.click('#btn-goto-precos');
  await page.waitForTimeout(150);
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
  await page.waitForTimeout(250);
  html = await appHtml(page);
  ok('Preços salvos sem erro (segue na tela de preços)', html.includes('Valores e datas-limite'));
  await page.click('#btn-back-admin3');
  await page.waitForTimeout(150);

  console.log('\n== 8. Painel admin — Ensaios (adicionar datas) ==');
  await page.click('#btn-goto-ensaios');
  await page.waitForTimeout(150);
  const hoje = new Date();
  const passado = new Date(hoje.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const futuro1 = new Date(hoje.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const futuro2 = new Date(hoje.getTime() + 14 * 86400000).toISOString().slice(0, 10);
  for (const d of [passado, futuro1, futuro2]) {
    await page.fill('#new-ensaio-data', d);
    await page.click('#btn-add-ensaio');
    await page.waitForTimeout(150);
  }
  html = await appHtml(page);
  ok('3 ensaios cadastrados', (html.match(/ensaio-data-input/g) || []).length === 3);
  ok('Ensaio passado marcado como Realizado', html.includes('Realizado'));
  ok('Ensaios futuros marcados como Agendado', html.includes('Agendado'));
  await page.click('#btn-back-admin4');
  await page.waitForTimeout(150);

  console.log('\n== 9. Painel admin — Cadastros (conceder isenção manual, dar acesso admin) ==');
  await page.click('#btn-goto-pessoas');
  await page.waitForTimeout(150);
  html = await appHtml(page);
  ok('Lista de pessoas mostra Ana, Bruno, Carla, Duda', ['Ana Silva', 'Bruno Costa', 'Carla Dias', 'Duda Reis'].every(n => html.includes(n)));
  ok('Carla (Voz) já aparece isenta automaticamente pela posição', html.includes('Isento') && html.includes('Carla'));

  // find Ana's edit button and grant her a manual isencao + admin access
  const users = await page.evaluate(() => window.__mock.dumpStore().users);
  const anaId = Object.keys(users).find(id => users[id].email === 'ana@example.com');
  await page.click(`[data-edit-user="${anaId}"]`);
  await page.waitForTimeout(150);
  await page.check(`#ae-isento-${anaId}`);
  await page.check(`#ae-adminaccess-${anaId}`);
  await page.click(`[data-admin-edit-form="${anaId}"] button[type=submit]`);
  await page.waitForTimeout(250);
  html = await appHtml(page);
  ok('Ana agora aparece com badge "Acesso admin"', html.includes('Acesso admin'));

  await page.click('#btn-back-admin2');
  await page.waitForTimeout(150);

  console.log('\n== 10. Painel admin — Relatório geral com filtros ==');
  await page.click('#btn-goto-relatorio');
  await page.waitForTimeout(150);
  html = await appHtml(page);
  ok('Relatório lista todas as pessoas', html.includes('Ana Silva') && html.includes('Duda Reis'));
  await page.selectOption('#relatorio-filtro-posicao', 'Repique');
  await page.waitForTimeout(150);
  html = await appHtml(page);
  ok('Filtro por posição (Repique) mostra só Duda', html.includes('Duda Reis') && !html.includes('Bruno Costa'));
  await page.selectOption('#relatorio-filtro-posicao', 'todas');
  await page.waitForTimeout(100);
  await logout(page);

  // ============================================================
  console.log('\n== 11. Ana escolhe plano de pagamento e registra um pagamento parcial ==');
  await login(page, 'ana@example.com');
  html = await appHtml(page);
  ok('Ana (isenta manual) vê "Anuidade ISENTA" e não vê formulário de plano', html.includes('Anuidade ISENTA'));

  // switch Ana off manual isencao to test real payment flow
  await logout(page);
  await login(page, 'bruno@example.com');
  await page.click('#btn-goto-admin');
  await page.click('#btn-goto-pessoas');
  await page.waitForTimeout(150);
  await page.click(`[data-edit-user="${anaId}"]`);
  await page.waitForTimeout(150);
  await page.uncheck(`#ae-isento-${anaId}`);
  await page.click(`[data-admin-edit-form="${anaId}"] button[type=submit]`);
  await page.waitForTimeout(200);
  await logout(page);

  await login(page, 'ana@example.com');
  html = await appHtml(page);
  ok('Sem isenção, Ana vê os planos de pagamento', html.includes('plan-picker'));
  await page.click('#plan-picker .plan-pill[data-plano="duasVezes"]');
  await page.waitForTimeout(250);
  html = await appHtml(page);
  ok('Após escolher plano 2x, mostra 2 parcelas', (html.match(/Parcela \d\/2/g) || []).length === 2);

  await page.click('#btn-toggle-addpay');
  await page.fill('#pay-data', hoje.toISOString().slice(0, 10));
  await page.fill('#pay-valor', '115');
  await page.fill('#pay-pix', 'ana@pix');
  await page.click('#btn-save-pay');
  await page.waitForTimeout(300);
  html = await appHtml(page);
  ok('Pagamento de R$115 registrado na lista', html.includes('ana@pix'));
  ok('Total pago (115 de 230, 50%) refletido na barra de progresso', html.includes('50%'));
  ok('Status muda para "No prazo" (não quitado ainda)', html.includes('No prazo'));

  console.log('\n== 12. Presença: Ana marca presença de Duda (outra pessoa) ==');
  await page.waitForTimeout(150);
  const dudaId = Object.keys(users).find(id => users[id].email === 'duda@example.com');
  html = await appHtml(page);
  const hasToggleForDuda = html.includes(`data-uid="${dudaId}"`);
  ok('Tabela de presença mostra linha da Duda', hasToggleForDuda);
  const toggleCount = await page.locator(`.toggle[data-uid="${dudaId}"]`).count();
  ok('Existe pelo menos um toggle de presença para Duda', toggleCount > 0);
  if (toggleCount > 0) {
    await page.locator(`.toggle[data-uid="${dudaId}"]`).first().click();
    await page.waitForTimeout(300);
    // re-consulta o DOM (render() substitui os elementos após o clique, então o
    // handle antigo fica desconectado — precisa buscar de novo, não reusar).
    const cls = await page.locator(`.toggle[data-uid="${dudaId}"]`).first().getAttribute('class');
    ok('Toggle de presença da Duda virou "on" após clique de Ana', cls.includes('on'));
  }

  console.log('\n== 13. Filtro de presença por posição e por ensaio ==');
  await page.selectOption('#presenca-filtro-posicao', 'Repique');
  await page.waitForTimeout(150);
  html = await appHtml(page);
  ok('Filtro por posição (Repique) mostra só Duda na tabela de presença', html.includes('Duda Reis') && !html.includes('Bruno Costa'));
  await page.selectOption('#presenca-filtro-posicao', 'todas');
  await page.waitForTimeout(100);

  console.log('\n== 14. Duda vê que Ana marcou presença dela (dado colaborativo, tempo real) ==');
  await logout(page);
  await login(page, 'duda@example.com');
  html = await appHtml(page);
  const toggleDuda = await page.$(`.toggle[data-uid="${dudaId}"]`);
  const cls2 = toggleDuda ? await toggleDuda.getAttribute('class') : '';
  ok('Presença marcada por Ana está visível para a própria Duda', cls2.includes('on'));

  await logout(page);

  console.log(`\n=== RESULTADO: ${pass} passaram, ${fail} falharam ===`);
  if (fail) { failures.forEach(f => console.log('  - ' + f)); }
  await browser.close();
  process.exitCode = fail ? 1 : 0;
}

main().catch(err => { console.error(err); process.exit(1); });
