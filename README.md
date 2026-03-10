# ReluAIBot 🤖

Un chatbot inteligent bazat pe arhitectură serverless folosind **Hono** și **Cloudflare Workers**.

## 🚀 Tehnologii
- **Framework:** [Hono](https://hono.dev/)
- **Runtime:** [Cloudflare Workers](https://workers.cloudflare.com/)
- **Limbaj:** TypeScript

## 🛠️ Setup Local

1. **Instalează dependențele:**
   ```bash
   npm install
   ```

2. **Rulează în modul de dezvoltare:**
   ```bash
   npm run dev
   ```

3. **Publicare pe Cloudflare:**
   ```bash
   npm run deploy
   ```

## 🏗️ Structura Proiectului
- `src/index.ts`: Punctul de intrare în aplicație și definirea rutelor.
- `wrangler.jsonc`: Configurarea pentru Cloudflare Workers.

## 🤖 Plan de Viitor
- [ ] Integrare OpenAI/Anthropic API pentru inteligență.
- [ ] Webhook pentru Telegram sau Discord.
- [ ] Stocare istoric conversații în Cloudflare D1 (SQL) sau KV.

---
Creat cu ❤️ pentru automatizare.
