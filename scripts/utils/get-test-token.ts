#!/usr/bin/env npx tsx
/**
 * Script to generate a test session token for Claude to use
 * Usage: npx tsx scripts/utils/get-test-token.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { createClerkClient } from '@clerk/nextjs/server';

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// Debug: Check if CLERK_SECRET_KEY is loaded
if (!process.env.CLERK_SECRET_KEY) {
  console.error('CLERK_SECRET_KEY not found in environment variables');
  console.error('Make sure .env.local exists and contains CLERK_SECRET_KEY');
  process.exit(1);
}

// Create Clerk client with explicit secret key
const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY
});

async function generateTestToken() {
  try {
    // First, create a testing token to bypass bot detection
    const testingToken = await clerk.testingTokens.createTestingToken();
    process.env.CLERK_TESTING_TOKEN = testingToken.token;
    
    console.log('Created Clerk testing token');
    
    // List users to find simon
    const users = await clerk.users.getUserList({ limit: 10 });
    console.log('\nAvailable users:');
    for (const user of users.data) {
      const email = user.emailAddresses[0]?.emailAddress || 'no email';
      const isPlatformAdmin = (user.privateMetadata as any)?.isPlatformAdmin === true;
      console.log(`- ${user.id}: ${email}${isPlatformAdmin ? ' (admin)' : ''}`);
    }
    
    // Find simon or the first admin user
    let testUser = users.data.find(u => 
      u.emailAddresses[0]?.emailAddress?.includes('simon') ||
      (u.privateMetadata as any)?.isPlatformAdmin === true
    );
    
    if (!testUser && users.data.length > 0) {
      testUser = users.data[0];
      console.log('\nUsing first available user:', testUser.emailAddresses[0]?.emailAddress);
    }
    
    if (!testUser) {
      console.error('No users found in Clerk');
      return;
    }
    
    const testUserId = testUser.id;
    console.log('\nGenerating token for user:', testUserId);
    
    // Get existing sessions for this user
    const sessions = await clerk.sessions.getSessionList({ userId: testUserId });
    
    if (!sessions.data || sessions.data.length === 0) {
      console.error('No existing sessions for test user. Please sign in with this user first.');
      return;
    }
    
    // Use the first active session (or first session if none are active)
    const activeSession = sessions.data.find(s => s.status === 'active') || sessions.data[0];
    const sessionId = activeSession.id;
    console.log('Using existing session:', sessionId);
    
    // Get a session JWT token with 30 minute expiration
    // The getToken method doesn't support custom expiration directly,
    // but we can try to get a longer-lived token
    const token = await clerk.sessions.getToken(sessionId);
    
    if (!token.jwt) {
      console.error('Failed to get JWT from session token');
      return;
    }
    
    // Decode token to show expiration time
    const payload = JSON.parse(Buffer.from(token.jwt.split('.')[1], 'base64').toString());
    const expiresAt = new Date(payload.exp * 1000);
    const validForSeconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
    
    console.log('\n========================================');
    console.log('Test Session Token Generated:');
    console.log('========================================');
    console.log(token.jwt);
    console.log('========================================');
    console.log('\nToken Details:');
    console.log('- User:', testUser.emailAddresses[0]?.emailAddress, `(${testUserId})`);
    console.log('- Admin:', (testUser.privateMetadata as any)?.isPlatformAdmin === true);
    console.log('- Valid for:', validForSeconds, 'seconds');
    console.log('- Expires at:', expiresAt.toLocaleTimeString());
    console.log('\nUsage:');
    console.log('curl -H "Authorization: Bearer <token>" http://localhost:3000/api/...');
    console.log('\nNote: Clerk test tokens expire after 60 seconds. Re-run this script to get a fresh token.');
    
    return token.jwt;
  } catch (error) {
    console.error('Error creating test session:', error);
  }
}

// Run the script
generateTestToken().then(() => process.exit(0));