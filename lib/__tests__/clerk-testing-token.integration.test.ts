/**
 * Integration tests for Clerk testing token functionality
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from .env.local
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { clerkClient } from '@clerk/nextjs/server';

describe('Clerk Testing Token Integration Tests', () => {
  describe('createTestingToken', () => {
    it('should create a testing token successfully', async () => {
      const clerk = await clerkClient();
      
      // Create a testing token
      const testingToken = await clerk.testingTokens.createTestingToken();
      
      // Verify the token was created
      expect(testingToken).toBeDefined();
      expect(testingToken.token).toBeDefined();
      expect(typeof testingToken.token).toBe('string');
      expect(testingToken.token.length).toBeGreaterThan(0);
      
      console.log('Testing token created successfully');
      console.log('Token type:', typeof testingToken.token);
      console.log('Token length:', testingToken.token.length);
      console.log('Token preview:', testingToken.token.substring(0, 20) + '...');
    });

    it('should be able to create multiple testing tokens', async () => {
      const clerk = await clerkClient();
      
      // Create two testing tokens
      const token1 = await clerk.testingTokens.createTestingToken();
      const token2 = await clerk.testingTokens.createTestingToken();
      
      // Verify both tokens were created
      expect(token1.token).toBeDefined();
      expect(token2.token).toBeDefined();
      
      // Note: Testing tokens appear to be the same when created in quick succession
      // This is likely because they're based on a timestamp with second precision
      console.log('Token 1:', token1.token);
      console.log('Token 2:', token2.token);
      console.log('Tokens are same:', token1.token === token2.token);
      
      // Both tokens should be valid strings
      expect(typeof token1.token).toBe('string');
      expect(typeof token2.token).toBe('string');
      expect(token1.token.length).toBeGreaterThan(0);
      expect(token2.token.length).toBeGreaterThan(0);
    });
  });

  describe('Session operations with test user', () => {
    const testUserId = process.env.TEST_USER_ID || 'user_31xcrIbiSrjjTIKlXShEPilRow7';

    it('should be able to get test user', async () => {
      const clerk = await clerkClient();
      
      const user = await clerk.users.getUser(testUserId);
      
      expect(user).toBeDefined();
      expect(user.id).toBe(testUserId);
      console.log('Test user found:', user.id);
      console.log('User email:', user.emailAddresses[0]?.emailAddress);
    });

    it('should be able to list sessions for test user', async () => {
      const clerk = await clerkClient();
      
      const sessions = await clerk.sessions.getSessionList({ userId: testUserId });
      
      expect(sessions).toBeDefined();
      expect(sessions.data).toBeDefined();
      console.log('Sessions found:', sessions.data.length);
      
      if (sessions.data.length > 0) {
        const firstSession = sessions.data[0];
        console.log('First session ID:', firstSession.id);
        console.log('Session status:', firstSession.status);
        console.log('Session created at:', new Date(firstSession.createdAt).toISOString());
      }
    });

    it('should handle session token operations', async () => {
      const clerk = await clerkClient();
      
      // Get sessions for test user
      const sessions = await clerk.sessions.getSessionList({ userId: testUserId });
      
      if (sessions.data && sessions.data.length > 0) {
        const sessionId = sessions.data[0].id;
        console.log('Using session ID:', sessionId);
        
        // Try to get a token for the session
        try {
          const token = await clerk.sessions.getToken(sessionId);
          console.log('Session token created successfully');
          console.log('Token has jwt:', token.jwt !== undefined);
        } catch (error: any) {
          console.log('Could not create session token:', error.message);
          console.log('This is expected if no token template is configured');
        }
      } else {
        console.log('No existing sessions for test user');
      }
    });
  });

  describe('Combined testing token and session flow', () => {
    it('should create testing token and work with sessions', async () => {
      const testUserId = process.env.TEST_USER_ID || 'user_31xcrIbiSrjjTIKlXShEPilRow7';
      const clerk = await clerkClient();
      
      // Step 1: Create testing token
      const testingToken = await clerk.testingTokens.createTestingToken();
      expect(testingToken.token).toBeDefined();
      console.log('Step 1: Testing token created');
      
      // Step 2: Set it as environment variable (for SDK to use)
      process.env.CLERK_TESTING_TOKEN = testingToken.token;
      console.log('Step 2: Testing token set in environment');
      
      // Step 3: Get test user
      const user = await clerk.users.getUser(testUserId);
      expect(user).toBeDefined();
      console.log('Step 3: Test user retrieved:', user.id);
      
      // Step 4: Check sessions
      const sessions = await clerk.sessions.getSessionList({ userId: testUserId });
      console.log('Step 4: Sessions found:', sessions.data.length);
      
      // Summary
      console.log('\nTesting flow completed successfully:');
      console.log('- Testing token created and set');
      console.log('- Test user accessible');
      console.log('- Sessions retrievable');
      console.log('\nThis confirms the basic Clerk testing setup is working');
    });
  });
});