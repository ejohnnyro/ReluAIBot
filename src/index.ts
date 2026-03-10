import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => {
  return c.text('ReluAIBot is online! 🤖')
})

export default app
