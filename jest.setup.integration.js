// Load environment variables from .env.local for integration tests
require("dotenv").config({ path: ".env.local" });

// Set NODE_ENV to 'test' so getEnvironment() returns 'test' namespace
process.env.NODE_ENV = "test";
