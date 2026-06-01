import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Initialize the SQLite database (this will create 'autoedit.db' in the root directory)
const db = new DatabaseSync('autoedit.db');

// Create the users table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

/**
 * Securely hashes a password using scrypt and a random salt
 */
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hashedBuffer = scryptSync(password, salt, 64);
  return { hash: hashedBuffer.toString('hex'), salt };
}

/**
 * Verifies a plaintext password against a stored hash and salt
 */
export function verifyPassword(password: string, hash: string, salt: string) {
  const hashedBuffer = scryptSync(password, salt, 64);
  const storedBuffer = Buffer.from(hash, 'hex');
  return timingSafeEqual(hashedBuffer, storedBuffer);
}

/**
 * Registers a new user in the database
 */
export function createUser(first_name: string, last_name: string, email: string, password: string) {
  const { hash, salt } = hashPassword(password);
  const insertStmt = db.prepare('INSERT INTO users (first_name, last_name, email, password_hash, salt) VALUES (?, ?, ?, ?, ?)');
  
  try {
    insertStmt.run(first_name, last_name, email, hash, salt);
    
    // Print the updated users table to the console in a table format
    const allUsers = db.prepare('SELECT id, first_name, last_name, email, created_at FROM users').all();
    console.table(allUsers);

    // Retrieve the user we just created to allow auto-login
    const newUserStmt = db.prepare('SELECT id, first_name, last_name, email FROM users WHERE email = ?');
    const user = newUserStmt.get(email) as any;

    return { 
      success: true, 
      message: 'User created successfully',
      user: { id: user.id, name: `${user.first_name} ${user.last_name}`, first_name: user.first_name, last_name: user.last_name, email: user.email }
    };
  } catch (error: any) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return { success: false, message: 'An account with this email already exists' };
    }
    throw error;
  }
}

/**
 * Authenticates an existing user
 */
export function authenticateUser(email: string, password: string) {
  const selectStmt = db.prepare('SELECT id, first_name, last_name, email, password_hash, salt FROM users WHERE email = ?');
  const user = selectStmt.get(email) as any;

  if (!user) {
    return { success: false, message: 'Invalid email or password' };
  }

  const isValid = verifyPassword(password, user.password_hash, user.salt);
  if (isValid) {
    return {
      success: true,
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        name: `${user.first_name} ${user.last_name}`,
      },
    };
  } else {
    return { success: false, message: 'Invalid email or password' };
  }
}

/**
 * Retrieves all users from the database (useful for displaying in a UI table)
 */
export function getAllUsers() {
  const selectStmt = db.prepare('SELECT id, first_name, last_name, email, created_at FROM users ORDER BY id ASC');
  return selectStmt.all();
}

export default db;