import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import piapiHandler from './api/piapi.js'

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function createNodeLikeResponse(res) {
  return {
    status(code) {
      res.statusCode = code
      return this
    },
    setHeader(name, value) {
      res.setHeader(name, value)
      return this
    },
    json(payload) {
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
      }
      res.end(JSON.stringify(payload))
      return this
    },
    send(payload) {
      if (Buffer.isBuffer(payload) || typeof payload === 'string') {
        res.end(payload)
      } else {
        if (!res.getHeader('Content-Type')) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
        }
        res.end(JSON.stringify(payload))
      }
      return this
    },
    end(payload) {
      res.end(payload)
      return this
    },
  }
}

function localApiBridge() {
  return {
    name: 'local-api-bridge',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/piapi')) return next()

        try {
          const url = new URL(req.url, 'http://localhost')
          req.query = Object.fromEntries(url.searchParams.entries())

          if (req.method === 'POST') {
            const raw = await readRequestBody(req)
            if (raw && raw.trim()) {
              try {
                req.body = JSON.parse(raw)
              } catch {
                req.body = {}
              }
            } else {
              req.body = {}
            }
          }

          const wrappedRes = createNodeLikeResponse(res)
          await piapiHandler(req, wrappedRes)
        } catch (err) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: err?.message || 'Local API bridge error' }))
        }
      })
    },
  }
}

// `BASE_PATH` lets subpath-hosted builds work, e.g. /my-app/.
// Leave unset for root-hosted deploys (Vercel/Netlify/Cloudflare/Replit/Render).
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react(), localApiBridge()],
})
