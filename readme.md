# 🐋 Agente DeepSeek

**Seu agente autônomo de código, movido pelo DeepSeek Web.**

Você descreve a tarefa em português. Ele lê os arquivos, planeja, edita e testa — tudo sozinho, direto na sua pasta do projeto.

---

## ⚠️ AVISO IMPORTANTE — LEIA ANTES DE USAR

> **Este app automatiza a interface web do DeepSeek.**
>
> O DeepSeek **não oferece uma API pública para este tipo de uso** — o agente controla o site como um usuário faria (cliques, digitação, leitura de respostas). Isso significa que **qualquer mudança no layout, nos seletores, no comportamento ou nas políticas do DeepSeek pode quebrar o app a qualquer momento, sem aviso prévio.**
>
> **Você usa por sua conta e risco.** O autor não se responsabiliza por:
> - Quebra de funcionalidade causada por mudanças no DeepSeek Web.
> - Suspensão, limitação ou encerramento da sua conta DeepSeek por uso automatizado.
> - Perda de dados, código ou contexto causada por falhas na automação.
> - Comandos executados incorretamente pelo agente.
>
> **Recomendações:**
> - **Use Git.** Faça commit antes de cada tarefa. É sua rede de segurança.
> - **Aprove comandos de shell com cuidado.** O agente pede confirmação, mas revise antes de aceitar.
> - **Não use em código sensível** que você não compartilharia com o DeepSeek.
> - **Não confie cegamente no agente.** Revise os diffs. Ele erra.
>
> Se o DeepSeek mudar algo e o app parar de funcionar, pode ser necessário ajustar os seletores em `bridge.js`. Isso é esperado neste tipo de integração.

---

## O que é

Um aplicativo desktop que transforma o **DeepSeek Web** em um **agente de código autônomo**. Diferente de chatbots que só conversam, este agente **age**: ele explora o projeto, lê os arquivos relevantes, edita o código, roda testes e entrega o resultado — tudo dentro de um ambiente controlado, com sua aprovação nos pontos críticos.

Não é uma IDE. Não é um copiloto passivo. É um **agente que trabalha enquanto você acompanha**.

---

## Para quem é

- Desenvolvedores que querem **delegar tarefas repetitivas** (refatorar, renomear, corrigir bugs, criar arquivos).
- Times que precisam **documentar ou revisar** um projeto inteiro sem abrir arquivo por arquivo.
- Quem já usa o DeepSeek Web e quer **ir além do chat**, sem pagar API por token.

---

## Como funciona, em uma frase

> Você escreve a tarefa. O agente lê, planeja, edita e te mostra cada passo — no seu computador, na sua pasta, com você no controle.

---

## ✨ Principais recursos

### 🤖 Agente autônomo de verdade
Não é "sugestão de código". O agente **executa**:
- Lê arquivos inteiros (com cache inteligente de trechos).
- Planeja edições usando referências de linha (`OLD_REF`).
- Cria arquivos novos (`WRITE`) ou modifica trechos exatos (`EDIT`).
- Executa comandos de build/teste (`RUN`) **com sua confirmação**.
- Finaliza sozinho quando a tarefa termina.

### 📁 Projetos organizados
- **Um projeto = uma pasta raiz.** Cada projeto tem suas próprias sessões, permissões e histórico.
- Crie, renomeie, altere a pasta raiz e remova projetos pela interface.
- Trocar de projeto recarrega o contexto automaticamente.

### 💬 Sessões ilimitadas por projeto
- Cada tarefa nova pode abrir uma **nova sessão no DeepSeek**, mantendo o projeto organizado.
- Navegue pelo histórico de sessões com busca por nome ou UUID.
- Abra sessões antigas em **modo somente leitura** para consultar decisões passadas.

### 📦 Compactação de contexto
Conversas longas ficam pesadas. O app detecta quando a sessão está grande e oferece **compactar**:
1. O agente resume a sessão em até 15 linhas.
2. Uma **nova sessão** é criada no DeepSeek.
3. O resumo é reinjetado automaticamente.
4. Você continua de onde parou — sem perder o fio.

A sessão antiga fica salva no histórico.

### 🔒 Aprovação de comandos perigosos
Comandos de shell (`RUN`) **nunca rodam sozinhos** por padrão. Você aprova em lote, com:
- Lista dos comandos.
- **Alerta de perigo** para operações destrutivas (`rm -rf`, `git reset --hard`, `curl | sh`…).
- Opção **"Sempre permitir"** por comando (válido por 24h, por projeto).

### 🛡️ Proteções inteligentes
- **Bloqueio de comandos via `RUN`** quando existe ferramenta nativa (`grep`, `find`, `cat`, `sed` → use `GREP`/`GLOB`/`READ`/`EDIT`).
- **Detecção de sintaxe PowerShell** (o shell padrão é `cmd.exe`).
- **Validação de sintaxe JS** antes de gravar (`node --check`) — nada de quebrar o projeto.
- **Detecção de template literals arrancados** pelo renderer do DeepSeek.
- **Bloqueio de edição dentro de comentários HTML**.
- **Validação de tags HTML balanceadas** após `EDIT`.
- **Detecção de truncamento** de resposta do modelo.

### 🧠 Edições à prova de falha
- **`OLD_REF`**: em vez de copiar o texto antigo, você usa o ID do `READ` (ex: `R1:216-330`).
- **Match em 3 níveis**: exato → por linha (ignorando espaços) → por tokens normalizados.
- **Detecção de conteúdo alterado** por fora (VS Code, etc).
- **Cache LRU** de trechos lidos (2000 entradas).
- **Auto-desminificação** de arquivos minificados ao ler.

### 🎨 Interface pensada para o trabalho
- **Chat com markdown completo**: títulos, listas, tabelas, código, alertas coloridos.
- **Cards de evento** para cada comando: diff visual, stdout/stderr separados, exit code.
- **Narração em tempo real**: o agente explica o que está fazendo.
- **Status bar** com tarefas, mensagens, chars e tokens estimados.
- **Banner de alerta** quando é hora de compactar.
- **Tema escuro**, tipografia legível, sem ruído.

### 🖥️ Janela do DeepSeek integrada
O app abre o **DeepSeek Web real** numa janela paralela. Você pode:
- Ver a conversa em tempo real.
- **Ocultar/mostrar** a janela quando quiser.
- Fazer login manualmente (sem armazenar senha).
- Abrir sessões antigas em popup somente leitura.

### 🔄 Retomada de sessão
Feche o app, abra de novo: **tudo volta ao lugar**.
- Projetos, sessões, resumos e permissões persistem.
- Posição e tamanho das janelas salvos.
- Escrita atômica do `projects.json` com backup (`.bak`).

### ⚡ Fluxo "pedir revisão"
Depois de uma tarefa que altera arquivos, o app oferece **🤖 Pedir revisão ao agente** — uma segunda passada de olho no que mudou, com um clique.

---

## 🧭 Como usar (passo a passo)

### 1. Instalar
```bash
npm install
```

### 2. Abrir
```bash
npm start
```

### 3. Fazer login no DeepSeek
Na primeira execução, o app abre o DeepSeek Web. Faça login **uma vez** — a sessão fica salva.

### 4. Criar um projeto
- Clique em **`+`** na barra lateral.
- Dê um nome (ex: "Loja Virtual").
- Escolha a **pasta raiz** do código.

### 5. Descrever a tarefa
Exemplos reais:

> **Corrigir bug**
> "O botão de adicionar ao carrinho não está funcionando no mobile. Investigue e corrija."

> **Refatorar**
> "Renomeie a função `handleLogin` para `authenticateUser` em todos os arquivos onde ela é usada."

> **Criar feature**
> "Crie um formulário de contato em `contact.html`, com validação em `contact.js` e estilos em `contact.css`. Use o mesmo padrão visual do resto do site."

> **Investigar**
> "Por que a página inicial está lenta? Analise o `index.html` e o `app.js` e sugira melhorias."

> **Documentar**
> "Leia o `server.js` e gere um `README` explicando as rotas da API."

### 6. Acompanhar
- O agente **narra** o que faz.
- Cada comando vira um **card** com resultado, diff e saída.
- Comandos de shell pedem **sua confirmação**.
- Ao terminar, você vê o resumo e pode **pedir revisão**.

---

## 📸 O que você vê na tela

```
┌─────────────────┬──────────────────────────────────────┐
│  PROJETOS       │  Loja Virtual                        │
│                 │  C:\projetos\loja · loja-virtual - 3 │
│  📁 Loja        ├──────────────────────────────────────┤
│  📁 API         │  Tarefas: 3  Mensagens: 47           │
│  📁 Site        │  Chars: 8.421  ~Tokens: 2.105        │
│                 ├──────────────────────────────────────┤
│                 │  🧑 Corrija o bug do carrinho        │
│                 │                                      │
│                 │  🤖 Vou investigar o `cart.js`...    │
│                 │  ▼ 📄 Leitura: cart.js               │
│                 │  ▼ ✏️ Alteração: cart.js             │
│                 │     - if (item.price = null)         │
│                 │     + if (item.price === null)       │
│                 │                                      │
│                 │  ✅ Corrigido. O problema era...     │
│                 │  [🤖 Pedir revisão ao agente]        │
│                 │                                      │
│                 ├──────────────────────────────────────┤
│                 │  [Descreva a próxima tarefa...]  ➤   │
└─────────────────┴──────────────────────────────────────┘
```

---

## 🎯 Casos de uso reais

| Você quer…                              | Como pedir                                                            |
| --------------------------------------- | --------------------------------------------------------------------- |
| Corrigir um bug                         | "O formulário de login está enviando vazio. Investigue e corrija."    |
| Renomear algo em todo o projeto         | "Renomeie `getUser` para `fetchUser` em todos os arquivos."           |
| Criar uma feature completa              | "Adicione dark mode. Crie o toggle no header e o CSS."                |
| Entender código legado                  | "Leia o `server.js` e explique o que cada rota faz."                  |
| Rodar testes e corrigir falhas          | "Rode os testes e corrija o que quebrar."                             |
| Documentar                              | "Gere um `README` para o projeto com base nos arquivos."              |
| Migrar código                           | "Migre o `index.js` de callback para async/await."                    |
| Aplicar padrão visual                   | "Deixe `contact.html` com o mesmo estilo de `about.html`."            |

---

## 🔐 Segurança e privacidade

- **Login manual.** O app nunca vê nem armazena sua senha. Você faz login no DeepSeek Web normalmente.
- **Sessão isolada.** O DeepSeek usa uma `partition` própria — nada vaza para outras janelas.
- **Nada de API key.** Você usa o DeepSeek Web como já faria no navegador.
- **Permissão explícita para shell.** Todo `RUN` perigoso exige aprovação.
- **Proteção contra comandos maliciosos.** `curl | sh`, PowerShell, comandos destrutivos, `git reset --hard` — todos exigem confirmação explícita.
- **Validação antes de gravar.** JS é checado com `node --check` antes de escrever no disco.
- **Escrita atômica dos dados.** `projects.json` usa `.tmp + rename` com backup `.bak`.
- **Nada sai da sua máquina** além do que o DeepSeek Web já processaria normalmente.

---

## 💡 Dicas para tirar o máximo

1. **Seja específico na tarefa.** "Corrija o bug do carrinho no mobile" rende mais que "arruma aí".
2. **Deixe o agente explorar.** Ele lê os arquivos certos sozinho. Não precisa listar cada um.
3. **Use o "Pedir revisão".** Uma segunda passada pega detalhes que passaram.
4. **Compacte antes de virar bagunça.** Quando o banner amarelo aparecer, compacte. É indolor.
5. **Aprove comandos recorrentes com "Sempre permitir".** `npm test`, `npm run build` — aprove uma vez, esqueça por 24h.
6. **Uma tarefa por sessão.** Se mudar de assunto, comece uma sessão nova (ou compacte).
7. **Não edite arquivos por fora durante a sessão.** O agente detecta e pede releitura, mas é mais lento.

---

## ❓ Perguntas frequentes

**Preciso de API key?**
Não. O app usa o DeepSeek Web que você já acessa no navegador.

**Funciona offline?**
Não. O DeepSeek Web precisa de internet.

**Meu código é enviado para o DeepSeek?**
Sim — os arquivos que o agente lê são enviados no chat, como você faria copiando e colando. **Não use em código que você não pode compartilhar com o DeepSeek.**

**E se o agente errar?**
Toda edição vira um card com diff. Você vê exatamente o que mudou. E pode pedir revisão ou simplesmente reverter no Git.

**Ele roda comandos sozinhos?**
Só comandos **seguros** (que você já aprovou). Comandos perigosos **sempre pedem confirmação**.

**Posso usar com qualquer projeto?**
Sim: HTML, CSS, JS, TS, JSON, PHP, Markdown, YAML… A formatação é automática por tipo de arquivo.

**E se eu fechar o app no meio?**
O estado é salvo. Ao reabrir, você retoma de onde parou (a tarefa em si é interrompida, mas o contexto fica).

**E se o DeepSeek mudar o site?**
Aí o app pode parar de funcionar até alguém ajustar os seletores em `bridge.js`. Isso é inerente a esse tipo de integração — veja o aviso no topo deste documento.

**Minha conta pode ser banida?**
Não sabemos. O DeepSeek pode ou não tolerar automação via navegador. **Use por sua conta e risco.**

**Quanto custa?**
O app é gratuito. O consumo é o do próprio DeepSeek Web, na sua conta.

---

## 🛠️ Requisitos

- **Windows, macOS ou Linux**
- **Node.js 18+**
- **Conta no DeepSeek** (gratuita)
- **Git** (opcional, mas **fortemente recomendado** para reverter mudanças)

---

## 🚀 Comece agora

```bash
git clone <seu-repo>
cd agente-web-deepseek
npm install
npm start
```

Faça login no DeepSeek. Crie um projeto. Descreva a tarefa. Assista.

**Mas não esqueça:** *use por sua conta e risco.*

---

**Agente DeepSeek** — porque programar não precisa ser solitário.

> _"Você pensa no problema. O agente pensa no código."_