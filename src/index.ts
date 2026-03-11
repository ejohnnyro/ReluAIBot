import { Hono } from 'hono'

type Bindings = {
  ALLOWED_USER_ID: string
  CF_ACCOUNT_ID: string
  OPENROUTER_API_KEY: string
  TELEGRAM_SECRET: string
  TELEGRAM_TOKEN: string
  WC_CONSUMER_KEY: string
  WC_CONSUMER_SECRET: string
  WOO_COMMERCE_URL: string
  GROQ_API_KEY: string
  ECOMPLEX_BOT_KV: KVNamespace
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => {
  return c.text('ReluAIBot is online! 🤖')
})

// Ruta de setup pentru setarea automata a webhook-ului
app.get('/setup', async (c) => {
  const url = `https://api.telegram.org/bot${c.env.TELEGRAM_TOKEN}/setWebhook?url=https://relu.ecomplex.workers.dev/webhook`
  const res = await fetch(url)
  const data = await res.json()
  return c.json(data)
})

// --- Helper WooCommerce Functions ---
async function fetchWooCommerce(endpoint: string, env: Bindings) {
  const auth = btoa(`${env.WC_CONSUMER_KEY}:${env.WC_CONSUMER_SECRET}`)
  const url = `${env.WOO_COMMERCE_URL}/wp-json/wc/v3${endpoint}`

  const response = await fetch(url, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    }
  })

  if (!response.ok) {
    throw new Error(`WooCommerce Error: ${response.statusText}`)
  }

  return await response.json()
}

async function searchProducts(query: string, env: Bindings) {
  const products: any = await fetchWooCommerce(`/products?search=${encodeURIComponent(query)}&per_page=5`, env)
  return products.map((p: any) => `ID: ${p.id} | SKU: ${p.sku} | Nume: ${p.name} | Pret: ${p.price} RON | Stoc: ${p.stock_status}`).join('\n')
}

async function getProductBySKU(sku: string, env: Bindings) {
  const products: any = await fetchWooCommerce(`/products?sku=${encodeURIComponent(sku)}`, env)
  if (products.length === 0) return "Produsul cu acest SKU nu a fost găsit."
  const p = products[0]
  return `Produs gasit:\nNume: ${p.name}\nSKU: ${p.sku}\nPret: ${p.price} RON\nStoc: ${p.stock_status}\nDescriere scurtă: ${p.short_description.replace(/<[^>]*>/g, '')}`
}

// --- Sub-Agent: Data Processor (Llama 8B via Groq) ---
async function processDataWithWorker(rawJson: any, task: string, env: Bindings) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content: "Esti sub-agentul tehnic Relu-Worker. Sarcina ta este sa primesti date brute JSON din WooCommerce si sa le transformi intr-un rezumat scurt, curat si util pentru Orchestratorul principal. Include ID, SKU, Nume, Pret si Stoc."
        },
        {
          role: "user",
          content: `Task: ${task}\nJSON: ${JSON.stringify(rawJson).slice(0, 5000)}`
        }
      ]
    })
  })
  const data = (await response.json()) as any
  return data.choices?.[0]?.message?.content || "Eroare la procesarea datelor de catre muncitor (Llama)."
}

// --- Webhook ---
app.post('/webhook', async (c) => {
  const body = (await c.req.json()) as any

  if (body.message && body.message.text) {
    const chatId = body.message.chat.id
    const userId = body.message.from.id.toString()
    const userText = body.message.text

    if (c.env.ALLOWED_USER_ID && userId !== c.env.ALLOWED_USER_ID) {
      return c.json({ status: 'unauthorized' })
    }

    // --- Pas 1: Memorie (KV) ---
    const historyKey = `history:${chatId}`
    let historyRaw = await c.env.ECOMPLEX_BOT_KV.get(historyKey)
    let history: { role: string, content: string }[] = historyRaw ? JSON.parse(historyRaw) : []

    // Prompt Master (Stepfun)
    const masterPrompt = `Esti Relu, Orchestratorul AI pentru ecomplex.ro.
Responsabilitati: Gestionezi conversatia cu administratorul.
Daca ai nevoie sa cauti sau sa verifici ceva in magazin, scrie DOAR comanda necesara in formatul:
[SEARCH: termen] - pentru cautare produse
[SKU: cod_sku] - pentru detalii produs specific
Dupa ce primesti datele de la worker, vei formula raspunsul final pentru utilizator.
Raspunde in limba romana, politicos.`

    try {
      // Pas 2: Master Decide (OpenRouter/Stepfun)
      const masterRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${c.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://relu.ecomplex.workers.dev",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "stepfun/step-3.5-flash:free",
          messages: [
            { role: "system", content: masterPrompt },
            ...history.slice(-10),
            { role: "user", content: userText }
          ]
        })
      })

      const masterData = (await masterRes.json()) as any
      let firstResponse = masterData.choices?.[0]?.message?.content || ""

      let finalReply = firstResponse

      // Pas 3: Executie & Worker (Daca Master a cerut ceva)
      if (firstResponse.includes('[SEARCH:') || firstResponse.includes('[SKU:')) {
        let rawData = null
        let taskDescription = ""

        if (firstResponse.includes('[SEARCH:')) {
          const query = firstResponse.match(/\[SEARCH:\s*(.*?)]/)?.[1] || ""
          rawData = await fetchWooCommerce(`/products?search=${encodeURIComponent(query)}&per_page=5`, c.env)
          taskDescription = `Rezumat pentru cautarea: ${query}`
        } else if (firstResponse.includes('[SKU:')) {
          const sku = firstResponse.match(/\[SKU:\s*(.*?)]/)?.[1] || ""
          rawData = await fetchWooCommerce(`/products?sku=${encodeURIComponent(sku)}`, c.env)
          taskDescription = `Detalii pentru SKU-ul: ${sku}`
        }

        // Delegam catre Worker (Groq/Llama) procesarea JSON-ului
        const workerRezumat = await processDataWithWorker(rawData, taskDescription, c.env)

        // Pas 4: Master Formuleaza Raspunsul Final
        const finalMasterRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${c.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "stepfun/step-3.5-flash:free",
            messages: [
              { role: "system", content: masterPrompt },
              ...history.slice(-10),
              { role: "user", content: userText },
              { role: "assistant", content: firstResponse },
              { role: "system", content: `Date returnate de muncitorul Relu-Worker:\n${workerRezumat}` }
            ]
          })
        })
        const finalMasterData = (await finalMasterRes.json()) as any
        finalReply = finalMasterData.choices?.[0]?.message?.content || finalReply
      }

      // Pas 5: Update History & Telegram
      history.push({ role: "user", content: userText })
      history.push({ role: "assistant", content: finalReply })
      await c.env.ECOMPLEX_BOT_KV.put(historyKey, JSON.stringify(history.slice(-20)), { expirationTtl: 86400 })

      await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: finalReply }),
      })

    } catch (error) {
      console.error("Eroare Orchestrator:", error)
      await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: "Relu are o eroare de sincronizare intre orchestrator si worker." }),
      })
    }
  }

  return c.json({ status: 'ok' })
})

export default app
