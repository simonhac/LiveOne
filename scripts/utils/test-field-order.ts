#!/usr/bin/env npx tsx

import * as dotenv from 'dotenv'
import * as path from 'path'

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { createClerkClient } from '@clerk/nextjs/server'

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!
})

async function main() {
  const user = await clerkClient.users.getUser('user_31xcrIbiSrjjTIKlXShEPilRow7')

  const metadata = user.privateMetadata as any

  if (metadata?.credentials?.[0]) {
    console.log('First credential:')
    console.log(JSON.stringify(metadata.credentials[0], null, 2))

    console.log('\nField order:')
    console.log(Object.keys(metadata.credentials[0]))
  }
}

main().catch(console.error)