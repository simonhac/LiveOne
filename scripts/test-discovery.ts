#!/usr/bin/env node

/**
 * Test script for Select.Live system discovery
 */

import { testDiscovery } from '../lib/selectlive-discovery'

// Import credentials from USER_SECRETS
let email: string | undefined
let password: string | undefined

try {
  const secrets = require('../USER_SECRETS')
  email = secrets.SELECTLIVE_CREDENTIALS.username
  password = secrets.SELECTLIVE_CREDENTIALS.password
  console.log('Using credentials from USER_SECRETS')
} catch (error) {
  // Try environment variables
  email = process.env.SELECTRONIC_EMAIL
  password = process.env.SELECTRONIC_PASSWORD
  console.log('Using credentials from environment variables')
}

if (!email || !password) {
  console.error('❌ No credentials found!')
  console.error('Please set SELECTRONIC_EMAIL and SELECTRONIC_PASSWORD environment variables')
  process.exit(1)
}

// Run the test
testDiscovery(email, password)
  .then(() => {
    console.log('✅ Test completed')
  })
  .catch((error) => {
    console.error('❌ Test failed:', error)
    process.exit(1)
  })