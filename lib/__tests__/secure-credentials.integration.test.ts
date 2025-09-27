/**
 * Integration tests for secure-credentials module
 * Uses actual Clerk API with test users
 */

import * as dotenv from 'dotenv'
import * as path from 'path'

// Load environment variables from .env.local
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { clerkClient } from '@clerk/nextjs/server'
import {
  storeVendorCredentials,
  getVendorCredentials,
  removeVendorCredentials,
  hasVendorCredentials,
  getAllVendorCredentials,
  type SelectLiveCredentials,
  type VendorType
} from '../secure-credentials'
import { getSelectLiveCredentials, storeSelectLiveCredentials } from '../selectronic/credentials'
import { storeEnphaseTokens, getEnphaseCredentials } from '../enphase/enphase-client'
import type { EnphaseCredentials, EnphaseTokens } from '../types/enphase'

describe('Secure Credentials Integration Tests', () => {
  let testUserId: string
  let client: any
  
  const selectLiveCredentials: SelectLiveCredentials = {
    email: 'test@example.com',
    password: 'secure_password'
  }
  
  const enphaseCredentials: EnphaseCredentials = {
    access_token: 'test_access_token',
    refresh_token: 'test_refresh_token',
    expires_at: new Date(Date.now() + 86400000), // 24 hours from now
    enphase_system_id: 'system_123',
    enphase_user_id: 'enphase_user_456'
  }

  beforeAll(async () => {
    // Create a test user in Clerk
    client = await clerkClient()
    
    try {
      const timestamp = Date.now()
      const testUser = await client.users.createUser({
        emailAddress: [`test-secure-creds-${timestamp}@example.com`],
        username: `test_user_${timestamp}`,
        firstName: 'Test',
        lastName: 'User',
        password: 'TestPassword123!',
        skipPasswordChecks: true,
        skipPasswordRequirement: true
      })
      
      testUserId = testUser.id
      console.log('Created test user:', testUserId)
    } catch (error) {
      console.error('Failed to create test user:', error)
      throw error
    }
  })

  afterAll(async () => {
    // Clean up: delete the test user
    if (testUserId) {
      try {
        await client.users.deleteUser(testUserId)
        console.log('Deleted test user:', testUserId)
      } catch (error) {
        console.error('Failed to delete test user:', error)
      }
    }
  })

  beforeEach(async () => {
    // Clear all credentials before each test
    if (testUserId && client) {
      await client.users.updateUser(testUserId, {
        privateMetadata: {}
      })
    }
  })

  describe('Generic Vendor Functions', () => {
    describe('storeVendorCredentials', () => {
      it('should store Select.Live credentials', async () => {
        const result = await storeVendorCredentials(
          testUserId,
          'select.live',
          selectLiveCredentials
        )

        expect(result.success).toBe(true)
        
        // Verify credentials were stored
        const user = await client.users.getUser(testUserId)
        expect(user.privateMetadata?.selectLiveCredentials).toMatchObject(selectLiveCredentials)
        expect(user.privateMetadata?.selectLiveCredentials?.created_at).toBeDefined()
      })

      it('should store Enphase credentials', async () => {
        const result = await storeVendorCredentials(
          testUserId,
          'enphase',
          enphaseCredentials
        )

        expect(result.success).toBe(true)
        
        // Verify credentials were stored
        const user = await client.users.getUser(testUserId)
        expect(user.privateMetadata?.enphaseCredentials).toMatchObject(enphaseCredentials)
        expect(user.privateMetadata?.enphaseCredentials?.created_at).toBeDefined()
      })

      it('should preserve existing metadata when storing credentials', async () => {
        // First store Select.Live credentials
        await storeVendorCredentials(testUserId, 'select.live', selectLiveCredentials)
        
        // Then store Enphase credentials
        await storeVendorCredentials(testUserId, 'enphase', enphaseCredentials)

        // Verify both are present
        const user = await client.users.getUser(testUserId)
        expect(user.privateMetadata?.selectLiveCredentials).toMatchObject(selectLiveCredentials)
        expect(user.privateMetadata?.enphaseCredentials).toMatchObject(enphaseCredentials)
      })
    })

    describe('getVendorCredentials', () => {
      it('should retrieve Select.Live credentials', async () => {
        // Store credentials first
        await storeVendorCredentials(testUserId, 'select.live', selectLiveCredentials)
        
        // Retrieve them
        const result = await getVendorCredentials(testUserId, 'select.live')
        
        expect(result).toMatchObject(selectLiveCredentials)
        expect(result?.created_at).toBeDefined()
      })

      it('should retrieve Enphase credentials', async () => {
        // Store credentials first
        await storeVendorCredentials(testUserId, 'enphase', enphaseCredentials)
        
        // Retrieve them
        const result = await getVendorCredentials(testUserId, 'enphase')
        
        expect(result).toMatchObject(enphaseCredentials)
        expect(result?.created_at).toBeDefined()
      })

      it('should return null when credentials do not exist', async () => {
        const result = await getVendorCredentials(testUserId, 'select.live')
        expect(result).toBeNull()
      })
    })

    describe('removeVendorCredentials', () => {
      it('should remove Select.Live credentials while preserving others', async () => {
        // Store both types of credentials
        await storeVendorCredentials(testUserId, 'select.live', selectLiveCredentials)
        await storeVendorCredentials(testUserId, 'enphase', enphaseCredentials)
        
        // Remove Select.Live
        const result = await removeVendorCredentials(testUserId, 'select.live')
        expect(result.success).toBe(true)
        
        // Verify Select.Live is gone but Enphase remains
        const user = await client.users.getUser(testUserId)
        expect(user.privateMetadata?.selectLiveCredentials).toBeUndefined()
        expect(user.privateMetadata?.enphaseCredentials).toMatchObject(enphaseCredentials)
      })

      it('should remove Enphase credentials while preserving others', async () => {
        // Store both types of credentials
        await storeVendorCredentials(testUserId, 'select.live', selectLiveCredentials)
        await storeVendorCredentials(testUserId, 'enphase', enphaseCredentials)
        
        // Remove Enphase
        const result = await removeVendorCredentials(testUserId, 'enphase')
        expect(result.success).toBe(true)
        
        // Verify Enphase is gone but Select.Live remains
        const user = await client.users.getUser(testUserId)
        expect(user.privateMetadata?.selectLiveCredentials).toMatchObject(selectLiveCredentials)
        expect(user.privateMetadata?.enphaseCredentials).toBeUndefined()
      })
    })

    describe('hasVendorCredentials', () => {
      it('should return true when credentials exist', async () => {
        await storeVendorCredentials(testUserId, 'select.live', selectLiveCredentials)
        
        const result = await hasVendorCredentials(testUserId, 'select.live')
        expect(result).toBe(true)
      })

      it('should return false when credentials do not exist', async () => {
        const result = await hasVendorCredentials(testUserId, 'select.live')
        expect(result).toBe(false)
      })
    })

    describe('getAllVendorCredentials', () => {
      it('should return all vendor credentials', async () => {
        await storeVendorCredentials(testUserId, 'select.live', selectLiveCredentials)
        await storeVendorCredentials(testUserId, 'enphase', enphaseCredentials)
        
        const result = await getAllVendorCredentials(testUserId)
        
        expect(result.selectLive).toMatchObject(selectLiveCredentials)
        expect(result.enphase).toMatchObject(enphaseCredentials)
        expect(result.selectLive?.created_at).toBeDefined()
        expect(result.enphase?.created_at).toBeDefined()
      })

      it('should return empty object when no credentials exist', async () => {
        const result = await getAllVendorCredentials(testUserId)
        
        expect(result).toEqual({
          selectLive: undefined,
          enphase: undefined
        })
      })

      it('should return partial credentials when only some exist', async () => {
        await storeVendorCredentials(testUserId, 'select.live', selectLiveCredentials)
        
        const result = await getAllVendorCredentials(testUserId)
        
        expect(result.enphase).toBeUndefined()
        expect(result.selectLive).toMatchObject(selectLiveCredentials)
        expect(result.selectLive?.created_at).toBeDefined()
        expect(typeof result.selectLive?.created_at).toBe('number')
      })
    })
  })

  describe('Vendor-specific Helper Functions', () => {
    it('storeSelectLiveCredentials should work', async () => {
      const result = await storeSelectLiveCredentials(testUserId, selectLiveCredentials)
      expect(result.success).toBe(true)
      
      const user = await client.users.getUser(testUserId)
      expect(user.privateMetadata?.selectLiveCredentials).toMatchObject(selectLiveCredentials)
      expect(user.privateMetadata?.selectLiveCredentials?.created_at).toBeDefined()
    })

    it('getSelectLiveCredentials should work', async () => {
      await storeSelectLiveCredentials(testUserId, selectLiveCredentials)
      
      const result = await getSelectLiveCredentials(testUserId)
      expect(result).toMatchObject(selectLiveCredentials)
      expect(result?.created_at).toBeDefined()
    })
  })

  describe('Enphase Helper Functions', () => {
    it('should store Enphase tokens correctly', async () => {
      const tokens: EnphaseTokens = {
        access_token: 'new_access',
        refresh_token: 'new_refresh',
        expires_in: 86400,
        token_type: 'bearer',
        enl_uid: 'user_123'
      }

      const result = await storeEnphaseTokens(testUserId, tokens, 'system_456')
      expect(result.success).toBe(true)
      
      // Verify credentials were transformed and stored correctly
      const user = await client.users.getUser(testUserId)
      const stored = user.privateMetadata?.enphaseCredentials
      
      expect(stored.access_token).toBe('new_access')
      expect(stored.refresh_token).toBe('new_refresh')
      expect(stored.enphase_system_id).toBe('system_456')
      expect(stored.enphase_user_id).toBe('user_123')
      expect(stored.expires_at.getTime()).toBeGreaterThan(Date.now())
      expect(stored.created_at).toBeDefined()
    })

    it('should get Enphase credentials', async () => {
      await storeVendorCredentials(testUserId, 'enphase', enphaseCredentials)
      
      const result = await getEnphaseCredentials(testUserId)
      expect(result).toMatchObject(enphaseCredentials)
      expect(result?.created_at).toBeDefined()
    })

    it('should remove Enphase credentials', async () => {
      await storeVendorCredentials(testUserId, 'select.live', selectLiveCredentials)
      await storeVendorCredentials(testUserId, 'enphase', enphaseCredentials)
      
      const result = await removeVendorCredentials(testUserId, 'enphase')
      expect(result.success).toBe(true)
      
      // Verify Enphase is gone but Select.Live remains
      const user = await client.users.getUser(testUserId)
      expect(user.privateMetadata?.selectLiveCredentials).toMatchObject(selectLiveCredentials)
      expect(user.privateMetadata?.enphaseCredentials).toBeUndefined()
    })
  })

  describe('Multiple Vendor Credentials', () => {
    it('should handle user with both Select.Live and Enphase credentials', async () => {
      // Store both credentials
      await storeVendorCredentials(testUserId, 'select.live', selectLiveCredentials)
      await storeVendorCredentials(testUserId, 'enphase', enphaseCredentials)
      
      // Retrieve all credentials
      const all = await getAllVendorCredentials(testUserId)
      
      expect(all.selectLive).toMatchObject(selectLiveCredentials)
      expect(all.enphase).toMatchObject(enphaseCredentials)
      
      // Check individual existence
      expect(await hasVendorCredentials(testUserId, 'select.live')).toBe(true)
      expect(await hasVendorCredentials(testUserId, 'enphase')).toBe(true)
    })

    it('should remove one vendor credential without affecting the other', async () => {
      // Store both
      await storeVendorCredentials(testUserId, 'select.live', selectLiveCredentials)
      await storeVendorCredentials(testUserId, 'enphase', enphaseCredentials)
      
      // Remove Select.Live
      await removeVendorCredentials(testUserId, 'select.live')
      
      // Verify only Select.Live was removed
      expect(await hasVendorCredentials(testUserId, 'select.live')).toBe(false)
      expect(await hasVendorCredentials(testUserId, 'enphase')).toBe(true)
      
      // Remove Enphase
      await removeVendorCredentials(testUserId, 'enphase')
      
      // Verify both are gone
      expect(await hasVendorCredentials(testUserId, 'select.live')).toBe(false)
      expect(await hasVendorCredentials(testUserId, 'enphase')).toBe(false)
    })

    it('should correctly check for existence of each vendor credential', async () => {
      // Initially neither exists
      expect(await hasVendorCredentials(testUserId, 'select.live')).toBe(false)
      expect(await hasVendorCredentials(testUserId, 'enphase')).toBe(false)
      
      // Add Select.Live
      await storeVendorCredentials(testUserId, 'select.live', selectLiveCredentials)
      expect(await hasVendorCredentials(testUserId, 'select.live')).toBe(true)
      expect(await hasVendorCredentials(testUserId, 'enphase')).toBe(false)
      
      // Add Enphase
      await storeVendorCredentials(testUserId, 'enphase', enphaseCredentials)
      expect(await hasVendorCredentials(testUserId, 'select.live')).toBe(true)
      expect(await hasVendorCredentials(testUserId, 'enphase')).toBe(true)
      
      // Remove Select.Live
      await removeVendorCredentials(testUserId, 'select.live')
      expect(await hasVendorCredentials(testUserId, 'select.live')).toBe(false)
      expect(await hasVendorCredentials(testUserId, 'enphase')).toBe(true)
    })
  })
})