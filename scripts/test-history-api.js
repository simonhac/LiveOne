#!/usr/bin/env node

/**
 * Script to run History API integration tests
 * 
 * Usage:
 *   npm run test:history                  # Test against local dev server
 *   npm run test:history:prod             # Test against production
 *   TEST_API_URL=https://example.com npm run test:history  # Test against custom URL
 */

const { spawn } = require('child_process');
const path = require('path');

// Determine the target environment
const isProduction = process.argv.includes('--prod');
const apiUrl = process.env.TEST_API_URL || (isProduction 
  ? 'https://liveone.vercel.app' 
  : 'http://localhost:3000');

console.log('🧪 Running History API Integration Tests');
console.log(`📍 Target: ${apiUrl}`);
console.log('');

// Set up environment variables
const env = {
  ...process.env,
  TEST_API_URL: apiUrl,
  NODE_ENV: 'test'
};

// If testing against production, ensure we have auth
if (isProduction && !process.env.AUTH_PASSWORD) {
  env.AUTH_PASSWORD = 'password'; // Default for production testing
}

// Run the tests
const testProcess = spawn('npx', [
  'jest',
  '--testMatch',
  '**/history-api.integration.test.ts',
  '--verbose',
  '--runInBand', // Run tests serially to avoid rate limiting
  '--detectOpenHandles'
], {
  env,
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..')
});

testProcess.on('close', (code) => {
  if (code === 0) {
    console.log('\n✅ All tests passed!');
  } else {
    console.log(`\n❌ Tests failed with code ${code}`);
    process.exit(code);
  }
});

testProcess.on('error', (err) => {
  console.error('Failed to start test process:', err);
  process.exit(1);
});