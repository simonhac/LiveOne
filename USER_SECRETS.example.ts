// Copy this file to USER_SECRETS.ts and fill in your actual credentials
// USER_SECRETS.ts is gitignored and will not be committed

// Selectronic Live API Credentials
export const SELECTLIVE_CREDENTIALS = {
  username: 'your-email@example.com',  // Your select.live email
  password: 'your-password',            // Your select.live password
  systemNumber: '1234',                 // Your system number from select.live
};

// LiveOne Dashboard Users
// Generate password hash: npm run hash-password your-password
export const LIVEONE_USERS = {
  'admin': {
    passwordHash: '$2b$10$yourBcryptHashHere',  // bcrypt hash of password
    displayName: 'Admin User'
  },
  // Add more users as needed
};

// Map users to their Selectronic systems (if multiple systems)
export const USER_TO_SYSTEM = {
  'admin': {
    systemNumber: '1234',
    displayName: 'Home System'
  },
  // Add more mappings as needed
};