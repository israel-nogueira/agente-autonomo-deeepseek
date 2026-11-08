<div align="center">

# 🐋 Agente DeepSeek

### Seu agente autônomo de código, movido pelo DeepSeek Web.

*Você descreve a tarefa em português. Ele lê, planeja, edita e testa — direto na sua pasta de projeto.*

<br>

![Electron](https://img.shields.io/badge/Electron-30-47848F?style=for-the-badge&logo=electron&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Plataformas](https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-555?style=for-the-badge)
![Status](https://img.shields.io/badge/status-experimental-f59e0b?style=for-the-badge)
![Risco](https://img.shields.io/badge/uso-por%20sua%20conta%20e%20risco-d73a49?style=for-the-badge)

<br>

[Aviso](#️-aviso-importante) •
[O que é](#-o-que-é) •
[Recursos](#-principais-recursos) •
[Como usar](#-como-usar) •
[Segurança](#-segurança-e-privacidade) •
[Dicas](#-dicas) •
[FAQ](#-perguntas-frequentes)

</div>

---

## ⚠️ Aviso importante

> [!NOTE]
> 🧪 **Projeto experimental.** Este app depende da interface web do DeepSeek e está em evolução: espere bugs, mudanças frequentes e possíveis quebras. Feedback e correções são bem-vindos.

> [!WARNING]
> **Este app automatiza a interface web do DeepSeek.**
>
> O DeepSeek **não oferece uma API pública para este tipo de uso**. O agente controla o site como um usuário faria (cliques, digitação, leitura de respostas). Qualquer mudança no layout, nos seletores, no comportamento ou nas políticas do DeepSeek **pode quebrar o app a qualquer momento, sem aviso prévio.**
>
> **Você usa por sua conta e risco.** O autor não se responsabiliza por:
> - Quebra de funcionalidade causada por mudanças no DeepSeek Web.
> - Suspensão, limitação ou encerramento da sua conta DeepSeek por uso automatizado.
> - Perda de dados, código ou contexto causada por falhas na automação.
> - Comandos executados incorretamente pelo agente.

> [!TIP]
> **Recomendações**
> - 🔖 **Use Git.** Faça commit antes de cada tarefa. É a sua rede de segurança.
> - 🔍 **Aprove comandos de shell com cuidado.** O agente pede confirmação, mas revise antes de aceitar.
> - 🔐 **Não use em código sensível** que você não compartilharia com o DeepSeek.
> - 👀 **Não confie cegamente no agente.** Revise os diffs. Ele erra.

Se o DeepSeek mudar algo e o app parar de funcionar, pode ser necessário ajustar os seletores em `bridge.js`. Isso é esperado neste tipo de integração.

---

## 🧩 O que é

Um aplicativo desktop que transforma o **DeepSeek Web** em um **agente de código autônomo**.

Diferente de chatbots que só conversam, este agente **age**: explora o projeto, lê os arquivos relevantes, edita o código, roda testes e entrega o resultado — tudo em um ambiente controlado, com a sua aprovação nos pontos críticos.

> Não é uma IDE. Não é um copiloto passivo. É um **agente que trabalha enquanto você acompanha**.

### 👥 Para quem é

| Perfil | O que ganha |
| :-- | :-- |
| 🧑‍💻 **Desenvolvedores** | Delegam tarefas repetitivas: refatorar, renomear, corrigir bugs, criar arquivos. |
| 👨‍👩‍👧 **Times** | Documentam ou revisam um projeto inteiro sem abrir arquivo por arquivo. |
| 💬 **Quem já usa o DeepSeek Web** | Vão além do chat, sem pagar API por token. |

### 🔄 Em uma frase

> Você escreve a tarefa. O agente lê, planeja, edita e mostra cada passo — no seu computador, na sua pasta, com você no controle.

---

## ✨ Principais recursos

### 🤖 Agente autônomo de verdade

O agente não sugere: ele **executa**.

| Comando | O que faz |
| :-- | :-- |
| `READ` | Lê arquivos inteiros, com cache inteligente de trechos. |
| `EDIT` | Modifica trechos exatos, usando referências de linha (`OLD_REF`). |
| `WRITE` | Cria arquivos novos. |
| `RUN` | Executa comandos de build/teste, **com a sua confirmação**. |
| `GREP` / `GLOB` | Busca em conteúdo e em nomes de arquivos. |

E finaliza sozinho quando a tarefa termina.

### 📁 Projetos organizados

- **Um projeto = uma pasta raiz.** Cada projeto tem suas próprias sessões, permissões e histórico.
- Crie, renomeie, altere a pasta raiz e remova projetos pela interface.
- Trocar de projeto recarrega o contexto automaticamente.

### 💬 Sessões ilimitadas por projeto

- Cada tarefa nova pode abrir uma **nova sessão no DeepSeek**, mantendo o projeto organizado.
- Navegue pelo histórico com **busca por nome ou UUID**.
- **Clique numa sessão antiga para carregá-la no chat do app:** o histórico é restaurado e a conversa correspondente abre no DeepSeek, pronta para continuar.
- Prefere só consultar? Cada sessão tem um botão para abrir em **popup somente leitura**.

### 📦 Compactação de contexto

Conversas longas ficam pesadas. O app detecta quando a sessão está grande e oferece **compactar**:

1. O agente resume a sessão em até 15 linhas.
2. Uma **nova sessão** é criada no DeepSeek.
3. O resumo é reinjetado automaticamente.
4. Você continua de onde parou, sem perder o fio.

A sessão antiga fica salva no histórico.

### 🔒 Aprovação de comandos perigosos

Comandos de shell (`RUN`) **nunca rodam sozinhos** por padrão. Você aprova em lote, com:

- Lista dos comandos.
- **Alerta de perigo** para operações destrutivas (`rm -rf`, `git reset --hard`, `curl | sh`…).
- Opção **"Sempre permitir"** por comando (válida por 24h, por projeto).

### 🛡️ Proteções inteligentes

- Bloqueio de `RUN` quando existe ferramenta nativa (`grep`, `find`, `cat`, `sed` → use `GREP`/`GLOB`/`READ`/`EDIT`).
- Detecção de sintaxe PowerShell (o shell padrão é `cmd.exe`).
- Validação de sintaxe JS antes de gravar (`node --check`): nada de quebrar o projeto.
- Detecção de template literals arrancados pelo renderer do DeepSeek.
- Bloqueio de edição dentro de comentários HTML.
- Validação de tags HTML balanceadas após `EDIT`.
- Detecção de truncamento de resposta do modelo.

### 🧠 Edições à prova de falha

- **`OLD_REF`**: em vez de copiar o texto antigo, o agente usa o ID do `READ` (ex.: `R1:216-330`).
- **Match em 3 níveis:** exato → por linha (ignorando espaços) → por tokens normalizados.
- **Detecção de conteúdo alterado por fora** (VS Code, etc.).
- **Cache LRU** de trechos lidos (2000 entradas).
- **Auto-desminificação** de arquivos minificados ao ler.

### 🎨 Interface pensada para o trabalho

- Chat com markdown completo: títulos, listas, tabelas, código e alertas coloridos.
- **Cards de evento** para cada comando: diff visual, stdout/stderr separados e exit code.
- **Narração em tempo real:** o agente explica o que está fazendo.
- **Status bar** com tarefas, mensagens, chars e tokens estimados.
- **Banner de alerta** quando é hora de compactar.
- Tema escuro, tipografia legível, sem ruído.

### 🖥️ Janela do DeepSeek integrada

O app abre o **DeepSeek Web real** numa janela paralela. Você pode:

- Ver a conversa em tempo real.
- **Ocultar/mostrar** a janela quando quiser.
- Fazer login manualmente (sem armazenar senha).

### 💾 Retomada de sessão

Feche o app, abra de novo: **tudo volta ao lugar**.

- Projetos, sessões, resumos e permissões persistem.
- Posição e tamanho das janelas são salvos.
- Escrita atômica do `projects.json` com backup (`.bak`).

### ⚡ Fluxo "pedir revisão"

Depois de uma tarefa que altera arquivos, o app oferece **🤖 Pedir revisão ao agente**: uma segunda passada de olho no que mudou, com um clique.

---

## 🧭 Como usar

### 1️⃣ Instalar

```bash
git clone https://github.com/SEU-USUARIO/SEU-REPO.git
cd agente-web-deepseek
npm install
```

### 2️⃣ Abrir

```bash
npm start
```

### 3️⃣ Fazer login no DeepSeek

Na primeira execução, o app abre o DeepSeek Web. Faça login **uma vez**; a sessão fica salva.

### 4️⃣ Criar um projeto

1. Clique em **`+`** na barra lateral.
2. Dê um nome (ex.: "Loja Virtual").
3. Escolha a **pasta raiz** do código.

### 5️⃣ Descrever a tarefa

| Você quer… | Como pedir |
| :-- | :-- |
| 🐛 Corrigir um bug | *"O formulário de login está enviando vazio. Investigue e corrija."* |
| 🏷️ Renomear em todo o projeto | *"Renomeie `getUser` para `fetchUser` em todos os arquivos."* |
| 🚀 Criar uma feature completa | *"Adicione dark mode. Crie o toggle no header e o CSS."* |
| 📖 Entender código legado | *"Leia o `server.js` e explique o que cada rota faz."* |
| 🧪 Rodar testes e corrigir | *"Rode os testes e corrija o que quebrar."* |
| 📝 Documentar | *"Gere um `README` para o projeto com base nos arquivos."* |
| 🔀 Migrar código | *"Migre o `index.js` de callback para async/await."* |
| 🎨 Aplicar padrão visual | *"Deixe `contact.html` com o mesmo estilo de `about.html`."* |

### 6️⃣ Acompanhar

- O agente **narra** o que faz.
- Cada comando vira um **card** com resultado, diff e saída.
- Comandos de shell pedem **sua confirmação**.
- Ao terminar, você vê o resumo e pode **pedir revisão**.

### 📸 O que você vê na tela

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

## 🔐 Segurança e privacidade

| | |
| :-- | :-- |
| 🔑 **Login manual** | O app nunca vê nem armazena a sua senha. |
| 🧱 **Sessão isolada** | O DeepSeek usa uma `partition` própria; nada vaza para outras janelas. |
| 🚫 **Sem API key** | Você usa o DeepSeek Web como já faria no navegador. |
| ✋ **Shell com permissão** | Todo `RUN` perigoso exige aprovação explícita. |
| ☠️ **Comandos de risco** | `curl \| sh`, PowerShell, comandos destrutivos e `git reset --hard` exigem confirmação. |
| ✅ **Validação antes de gravar** | JS é checado com `node --check` antes de ir para o disco. |
| 💽 **Escrita atômica** | `projects.json` usa `.tmp` + rename, com backup `.bak`. |
| 🏠 **Nada sai da máquina** | Só o que o DeepSeek Web já processaria normalmente. |

---

## 💡 Dicas

> [!TIP]
> 1. **Seja específico.** "Corrija o bug do carrinho no mobile" rende mais que "arruma aí".
> 2. **Deixe o agente explorar.** Ele lê os arquivos certos sozinho; não precisa listar cada um.
> 3. **Use o "Pedir revisão".** Uma segunda passada pega detalhes que passaram.
> 4. **Compacte antes de virar bagunça.** Quando o banner amarelo aparecer, compacte. É indolor.
> 5. **Aprove comandos recorrentes com "Sempre permitir".** `npm test`, `npm run build`: aprove uma vez, esqueça por 24h.
> 6. **Uma tarefa por sessão.** Mudou de assunto? Comece uma sessão nova (ou compacte).
> 7. **Não edite arquivos por fora durante a sessão.** O agente detecta e pede releitura, mas fica mais lento.

---

## ❓ Perguntas frequentes

<details>
<summary><b>Preciso de API key?</b></summary>
<br>
Não. O app usa o DeepSeek Web que você já acessa no navegador.
</details>

<details>
<summary><b>Funciona offline?</b></summary>
<br>
Não. O DeepSeek Web precisa de internet.
</details>

<details>
<summary><b>Meu código é enviado para o DeepSeek?</b></summary>
<br>
Sim. Os arquivos que o agente lê são enviados no chat, como se você copiasse e colasse. <b>Não use em código que você não pode compartilhar com o DeepSeek.</b>
</details>

<details>
<summary><b>E se o agente errar?</b></summary>
<br>
Toda edição vira um card com diff, então você vê exatamente o que mudou. Pode pedir revisão ou simplesmente reverter no Git.
</details>

<details>
<summary><b>Ele roda comandos sozinho?</b></summary>
<br>
Só comandos <b>seguros</b> que você já aprovou. Comandos perigosos <b>sempre pedem confirmação</b>.
</details>

<details>
<summary><b>Posso usar com qualquer projeto?</b></summary>
<br>
Sim: HTML, CSS, JS, TS, JSON, PHP, Markdown, YAML… A formatação é automática por tipo de arquivo.
</details>

<details>
<summary><b>E se eu fechar o app no meio de uma tarefa?</b></summary>
<br>
O estado é salvo. Ao reabrir, você retoma de onde parou (a tarefa em si é interrompida, mas o contexto fica).
</details>

<details>
<summary><b>E se o DeepSeek mudar o site?</b></summary>
<br>
O app pode parar de funcionar até alguém ajustar os seletores em <code>bridge.js</code>. Isso é inerente a este tipo de integração; veja o <a href="#️-aviso-importante">aviso no topo</a>.
</details>

<details>
<summary><b>Minha conta pode ser banida?</b></summary>
<br>
Não sabemos. O DeepSeek pode ou não tolerar automação via navegador. <b>Use por sua conta e risco.</b>
</details>

<details>
<summary><b>Quanto custa?</b></summary>
<br>
O app é gratuito. O consumo é o do próprio DeepSeek Web, na sua conta.
</details>

---

## 🛠️ Requisitos

| Item | Detalhe |
| :-- | :-- |
| 💻 **Sistema** | Windows, macOS ou Linux |
| 🟢 **Node.js** | 18 ou superior |
| 🐋 **Conta DeepSeek** | Gratuita |
| 🌿 **Git** | Opcional, mas **fortemente recomendado** para reverter mudanças |

---

<div align="center">

### 🚀 Comece agora

`npm install` → `npm start` → faça login → crie um projeto → descreva a tarefa → assista.

**Mas não esqueça:** *use por sua conta e risco.*

<br>

**🐋 Agente DeepSeek** — porque programar não precisa ser solitário.

<sub>*"Você pensa no problema. O agente pensa no código."*</sub>

</div>