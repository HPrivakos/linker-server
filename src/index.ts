import 'dotenv/config'
import express from 'express'
import { fetch } from 'undici'
import multer from 'multer'
import { readFile } from 'fs/promises'
import cors from 'cors'
import FormData from 'form-data'

import { addModelToFormData } from 'dcl-catalyst-client'
import { postForm } from 'dcl-catalyst-commons'
import { Authenticator } from 'dcl-crypto'
import { verifyMessage } from '@ethersproject/wallet'
import { Wallet } from '@ethersproject/wallet'

const wallet = new Wallet(process.env.PK)

let db: { [address: string]: string[] } = {}

const PORT = 3000

const upload = multer({ dest: 'distFiles/', preservePath: true })

const app = express()
app.use(cors({ origin: '*' }))
app.use(express.json() as any)

app.get('/health/ready', async (req, res) => {
  res.status(200).send('ready')
})
app.get('/health/startup', async (req, res) => {
  res.status(200).send('[server] ok')
})
app.get('/health/live', async (req, res) => {
  res.status(200).send('alive')
})

app.get('/about', async (req, res) => {
  const url = req.hostname

  res.status(200).json({
    acceptingUsers: true,
    bff: { healthy: false, publicUrl: `${url}/bff` },
    comms: {
      healthy: true,
      protocol: 'v3',
      fixedAdapter: `offline:offline`
    },
    configurations: {
      networkId: 0,
      globalScenesUrn: [],
      scenesUrn: [],
      realmName: 'LinkerServer'
    },
    content: {
      healthy: true,
      publicUrl: `${url}/content`
    },
    lambdas: {
      healthy: true,
      publicUrl: `${url}/lambdas`
    },
    healthy: true
  })
})

app.get('/content/available-content', async (req, res) => {
  console.log('/content/available-content')
  console.log(req.url)

  const response = await fetch(`https://${process.env.CATALYST_DOMAIN!}/` + req.url)
  const text = await response.text()
  for (const header of response.headers) {
    if (header[0].startsWith('content-type')) res.setHeader(header[0], header[1])
    if (header[0].startsWith('access-control-')) res.setHeader(header[0], header[1])
  }

  res.status(response.status).end(text)
})

app.post('/content/entities', upload.any(), async (req, res) => {
  console.log('/content/entities')

  const auth: { type: string; payload: string; signature: string }[] = JSON.parse(JSON.stringify(req.body.authChain))

  const authSigner = auth.find((a) => a.type === 'SIGNER')
  if (!authSigner) return res.status(403).send('No AuthChain SIGNER')

  const dbSigner = db[authSigner.payload.toLowerCase()]
  if (!dbSigner) return res.status(403).send('Address not found')

  const authSignedEntity = auth.find((a) => a.type === 'ECDSA_SIGNED_ENTITY')
  if (!authSignedEntity) return res.status(403).send('No signature')

  const address = verifyMessage(authSignedEntity.payload, authSignedEntity.signature)
  console.log(address.toString(), authSigner.payload)

  if (address.toString().toLowerCase() != authSigner.payload.toLowerCase())
    return res.status(403).send("Address don't match")
  console.log(address.toString())

  const entityFile = JSON.parse(JSON.stringify(req.files)).find((a: any) => a.originalname == req.body.entityId)
  const entity = await readFile(entityFile.path).then((r) => JSON.parse(r.toString()))

  for (const pointer of entity.pointers) {
    if (dbSigner.indexOf(pointer) == -1) return res.status(403).send("You don't have access to this land")
  }

  //Authenticator.validateSignature(req.body.entityId, ), provider);
  const form = new FormData()

  form.append('entityId', req.body.entityId)
  const sig = await wallet.signMessage(req.body.entityId)

  // You can then create a simple auth chain like this, or a more complex one.
  const authChain = Authenticator.createSimpleAuthChain(req.body.entityId, wallet.address.toString(), sig)

  addModelToFormData(JSON.parse(JSON.stringify(authChain)), form, 'authChain')
  for (const file of <any>req.files) {
    await form.append(file.fieldname, await readFile(file.path), file.fieldname)
    console.log(`adding ${file.fieldname}`)
  }

  try {
    res.setHeader('X-Extend-CF-Timeout', 10)
    const ret = await postForm(`https://${process.env.CATALYST_DOMAIN!}/content/entities`, {
      body: form as any,
      headers: { 'x-upload-origin': 'dcl_linker' },
      timeout: '10m'
    })
    console.log(ret)
    res.send(ret).end()
  } catch (error: any) {
    console.log(error)

    res.status(400).send(error.toString())
  }
})

async function main() {
  await updateDB()

  app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`)
  })
}

void main()

async function updateDB() {
  try {
    const res = (await readFile('./authorizations.json')).toString()
    const json = JSON.parse(res)
    db = convertAuthorizationsToList(json as any)
  } catch (error) {}
}
function validatePlot(plot: string): boolean {
  const split = plot.split(',')
  if (split.length != 2) return false
  const x = +split[0]
  const y = +split[1]
  if (isNaN(x) || isNaN(y)) return false
  if (x < -200 || x > 200 || y < -200 || y > 200) return false
  return true
}

function convertAuthorizationsToList(authorizations: Authorizations): AuthorizationsList {
  const list: AuthorizationsList = {}

  for (const authorization of authorizations) {
    if (authorization.startDate && +new Date(authorization.startDate) < +new Date()) continue
    if (authorization.endDate && +new Date(authorization.endDate) > +new Date()) continue

    for (const address of authorization.addresses) {
      const add = address.toLowerCase()
      if (!list[add]) list[add] = []
      for (const plot of authorization.plots) {
        if (validatePlot(plot)) list[add].push(plot)
      }
    }
  }

  return list
}

interface Authorization {
  name: string
  desc: string
  startDate?: number
  endDate?: number
  contactInfo: {
    name: string
    [key: string]: string
  }
  addresses: string[]
  plots: string[]
}
type Authorizations = Authorization[]

type AuthorizationsList = {
  [address: string]: string[]
}
