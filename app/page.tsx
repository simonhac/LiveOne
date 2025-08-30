import { currentUser } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'

export default async function HomePage() {
  const user = await currentUser()
  
  if (!user) {
    redirect('/sign-in')
  }
  
  // User is authenticated, redirect to dashboard
  redirect('/dashboard')
}