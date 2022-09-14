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
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

let wallet = new Wallet('0x0000000000000000000000000000000000000000000000000000000000000001')


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

  const dbSigner = db[authSigner.payload]
  if (!dbSigner) return res.status(403).send('Address not found')

  const authSignedEntity = auth.find((a) => a.type === 'ECDSA_SIGNED_ENTITY')
  if (!authSignedEntity) return res.status(403).send('No signature')

  const address = verifyMessage(authSignedEntity.payload, authSignedEntity.signature)
  console.log(address.toString(), authSigner.payload)

  if (address.toString().toLowerCase() != authSigner.payload.toLowerCase())
    return res.status(403).send("Address don't match")
  console.log(address.toString())
  console.log(req)

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
    const { creationTimestamp } = (await postForm(`https://${process.env.CATALYST_DOMAIN!}/content/entities`, {
      body: form as any,
      headers: { 'x-upload-origin': 'dcl_linker' },
      timeout: '10m'
    })) as any
    console.log({ creationTimestamp })
    res.send({ creationTimestamp })
  } catch (error: any) {
    console.log(error)

    res.status(400).send(error.toString())
  }
})

async function main() {
  const SMClient = new SecretsManagerClient({ region: 'us-east-1' })
  const command = new GetSecretValueCommand({ SecretId: 'linker-server' })
  const response = await SMClient.send(command)
  const json = JSON.parse(response.SecretString!)
  wallet = new Wallet(json.private_key)
  await updateDB()

  app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`)
  })
}

void main()

async function updateDB() {
  try {
    const res = await fetch('https://decentraland.github.io/linker-server-authorizations/db.json')
    const json = await res.json()
    db = json as any
  } catch (error) {}
}

setInterval(updateDB, 10 * 60 * 1000)
