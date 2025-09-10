// Development-only route for database syncing
// In production builds, route.production.ts will be used instead

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { isUserAdmin } from '@/lib/auth-utils'
import { db } from '@/lib/db'
import { clerkIdMapping } from '@/lib/db/schema'
import { syncStages, type SyncContext, type StageDefinition } from './stages'

// Helper to create a streaming response
function createStreamResponse() {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController

  const stream = new ReadableStream({
    start(c) {
      controller = c
    }
  })

  const send = (data: any) => {
    const line = JSON.stringify(data) + '\n'
    controller.enqueue(encoder.encode(line))
  }

  const close = () => {
    controller.close()
  }

  return { stream, send, close }
}

// Stage status type
interface SyncStage {
  id: string
  name: string
  status: 'pending' | 'running' | 'completed' | 'error'
  detail?: string
  progress?: number  // 0-1 for proportion complete within the stage
  startTime?: number
  duration?: number
}

export async function POST(request: NextRequest) {
  // CRITICAL: This endpoint must NEVER run in production
  // Multiple checks to ensure safety:
  // 1. Check if we're on the production domain
  // 2. Check if we're using the production database
  // 3. Check Vercel environment
  
  const host = request.headers.get('host')
  const isProductionDomain = host?.includes('liveone.energy') || host?.includes('liveone.vercel.app')
  const isProductionDatabase = process.env.TURSO_DATABASE_URL?.includes('liveone-tokyo')
  const isVercelProduction = process.env.VERCEL_ENV === 'production'
  
  if (isProductionDomain || (isProductionDatabase && isVercelProduction)) {
    console.error(`CRITICAL: Attempt to run sync-database in production! Host: ${host}, Vercel Env: ${process.env.VERCEL_ENV}`)
    return NextResponse.json({ 
      error: 'Not found' 
    }, { status: 404 })
  }
  
  try {
    // Check if user is authenticated and admin
    const { userId } = await auth()
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    const isAdmin = await isUserAdmin()
    
    if (!isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    
    const tursoUrl = process.env.TURSO_DATABASE_URL
    const tursoToken = process.env.TURSO_AUTH_TOKEN
    
    if (!tursoUrl || !tursoToken) {
      return NextResponse.json({ 
        error: 'Production database credentials not configured' 
      }, { status: 400 })
    }
    
    // Create streaming response
    const { stream, send, close } = createStreamResponse()
    
    // Start the sync process in the background
    syncDatabase(send, close, request.signal).catch(err => {
      console.error('Sync error:', err)
      send({ type: 'error', message: err.message })
      close()
    })
    
    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      },
    })
    
  } catch (error) {
    console.error('Sync initialisation error:', error)
    return NextResponse.json({
      error: 'Failed to start sync',
    }, { status: 500 })
  }
}

async function syncDatabase(
  send: (data: any) => void,
  close: () => void,
  signal: AbortSignal
) {
  // Calculate total estimated duration and progress allocations
  const totalEstimatedMs = syncStages.reduce((sum, stage) => sum + stage.estimatedDurationMs, 0)
  let cumulativeProgress = 0
  const progressAllocations = new Map<string, { start: number, end: number }>()
  
  for (const stage of syncStages) {
    const start = cumulativeProgress
    const end = cumulativeProgress + (stage.estimatedDurationMs / totalEstimatedMs) * 100
    progressAllocations.set(stage.id, { start, end })
    cumulativeProgress = end
  }
  
  // Initialise all stages upfront
  const stages: SyncStage[] = syncStages.map(def => ({
    id: def.id,
    name: def.name,
    status: 'pending' as const
  }))
  
  // Helper to update and send stage status
  const updateStage = (id: string, updates: Partial<SyncStage>) => {
    const stage = stages.find(s => s.id === id)
    if (stage) {
      Object.assign(stage, updates)
      if (updates.status === 'running' && !stage.startTime) {
        stage.startTime = Date.now()
        console.log(`[SYNC] Stage '${stage.name}' started at ${new Date(stage.startTime).toISOString()}`)
      }
      if (updates.status === 'completed' && stage.startTime) {
        const endTime = Date.now()
        stage.duration = (endTime - stage.startTime) / 1000
        console.log(`[SYNC] Stage '${stage.name}' completed in ${stage.duration.toFixed(3)}s (${stage.duration < 1 ? `${Math.round(stage.duration * 1000)}ms` : `${stage.duration.toFixed(1)}s`})`)
      }
      if (updates.status === 'error') {
        console.log(`[SYNC] Stage '${stage.name}' failed: ${updates.detail || 'Unknown error'}`)
      }
      
      // Send the updated stage
      send({ 
        type: 'stage-update', 
        stage: {
          id: stage.id,
          name: stage.name,
          status: stage.status,
          detail: stage.detail,
          progress: stage.progress,
          startTime: stage.startTime,
          duration: stage.duration
        }
      })
      
      // Update overall progress bar based on stage's internal progress
      if (updates.progress !== undefined) {
        const allocation = progressAllocations.get(id)
        if (allocation) {
          const overallProgress = allocation.start + (updates.progress * (allocation.end - allocation.start))
          send({ 
            type: 'progress', 
            message: stage.detail || `${stage.name}: ${Math.round(updates.progress * 100)}%`, 
            progress: Math.round(overallProgress), 
            total: 100 
          })
        }
      }
    }
  }
  
  // Format datetime helper
  const formatDateTime = (date: Date) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const day = date.getDate()
    const month = months[date.getMonth()]
    const year = date.getFullYear()
    const hours = date.getHours()
    const minutes = date.getMinutes().toString().padStart(2, '0')
    const ampm = hours >= 12 ? 'pm' : 'am'
    const displayHours = hours % 12 || 12
    return `${day} ${month} ${year} ${displayHours}:${minutes}${ampm}`
  }
  
  // Build initial context
  let context: SyncContext = {
    db,
    prodDb: null as any,
    signal,
    updateStage,
    send,
    clerkMappings: new Map(),
    mapClerkId: () => undefined,
    systemIdMappings: new Map(),
    mapSystemId: () => undefined,
    formatDateTime
  }
  
  try {
    // Send initial stages (all at once for initialization)
    send({ type: 'stages-init', stages: [...stages] })
    
    // Load Clerk ID mappings upfront (needed for context)
    try {
      const mappings = await db.select().from(clerkIdMapping)
      console.log(`[SYNC] Found ${mappings.length} Clerk ID mappings`)
      for (const mapping of mappings) {
        context.clerkMappings.set(mapping.prodClerkId, mapping.devClerkId)
        console.log(`[SYNC] Loaded mapping: ${mapping.username} - prod:${mapping.prodClerkId.slice(0, 15)}... -> dev:${mapping.devClerkId.slice(0, 15)}...`)
      }
      context.mapClerkId = (prodId: string | null | undefined): string | undefined => {
        if (!prodId) return undefined
        const mappedId = context.clerkMappings.get(prodId)
        if (!mappedId) {
          console.warn(`Warning: No dev Clerk ID mapping for production ID: ${prodId} - skipping`)
          return undefined // CRITICAL: Never copy production IDs to dev
        }
        return mappedId
      }
    } catch (err: any) {
      console.error('[SYNC] Error loading Clerk ID mappings:', err.message)
      context.mapClerkId = (prodId: string | null | undefined): string | undefined => {
        console.warn(`Warning: No dev Clerk ID mapping for production ID: ${prodId} - skipping`)
        return undefined
      }
    }
    
    // Execute stages in sequence
    for (const stageDef of syncStages) {
      if (signal.aborted) throw new Error('Sync cancelled')
      
      const allocation = progressAllocations.get(stageDef.id)!
      
      // Update stage to running (progress will be sent by updateStage)
      updateStage(stageDef.id, { status: 'running', progress: 0 })
      
      try {
        // Execute the stage
        const result = await stageDef.execute(context)
        
        // Update context with any changes from the stage
        if (result.context) {
          Object.assign(context, result.context)
        }
        
        // Mark stage as completed (100% progress)
        updateStage(stageDef.id, { 
          status: 'completed', 
          detail: result.detail,
          progress: 1
        })
        
        // Special handling for early exit (no data to sync)
        if (stageDef.id === 'count-data' && context.totalToSync === 0) {
          // Mark remaining stages as completed/skipped
          const remainingStages = syncStages.slice(syncStages.indexOf(stageDef) + 1)
          for (const remaining of remainingStages) {
            if (remaining.id === 'finalise') {
              updateStage(remaining.id, { status: 'completed', detail: 'Complete', progress: 1 })
            } else {
              updateStage(remaining.id, { status: 'completed', detail: 'Skipped - no new data', progress: 1 })
            }
          }
          
          send({ 
            type: 'progress', 
            message: 'Local database is already up to date!', 
            progress: 100, 
            total: 100 
          })
          send({ type: 'complete' })
          close()
          return
        }
        
      } catch (error: any) {
        // Mark stage as failed
        updateStage(stageDef.id, { 
          status: 'error', 
          detail: error.message 
        })
        
        // Stop processing
        throw error
      }
    }
    
    // All stages completed successfully
    send({ 
      type: 'progress', 
      message: `Successfully synced ${context.synced?.toLocaleString() || 0} readings from production!`, 
      progress: 100, 
      total: 100 
    })
    send({ type: 'complete' })
    close()
    
  } catch (error: any) {
    if (error.message === 'Sync cancelled') {
      send({ type: 'error', message: 'Sync was cancelled by user' })
    } else {
      console.error('Sync error:', error)
      send({ type: 'error', message: error.message || 'Sync failed' })
    }
    close()
  }
}