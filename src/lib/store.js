const users = new Map()
const salons = new Map()
const staffSessions = new Map()

export function listUsers() {
  return [...users.values()]
}

export function getUserById(id) {
  return users.get(id) ?? null
}

export function getUserByEmail(email) {
  const key = email.trim().toLowerCase()
  return [...users.values()].find(user => user.email.toLowerCase() === key) ?? null
}

export function getUserByPhone(phone) {
  return [...users.values()].find(user => user.phone === phone) ?? null
}

export function saveUser(user) {
  users.set(user.id, user)
  return user
}

export function removeUser(userId) {
  users.delete(userId)
  staffSessions.delete(userId)
}

export function listSalons() {
  return [...salons.values()]
}

export function saveSalon(salon) {
  salons.set(salon.id, salon)
  return salon
}

export function createStaffSession(userId, token) {
  staffSessions.set(userId, token)
}

export function getStaffSession(userId) {
  return staffSessions.get(userId) ?? null
}

/** Accept cookie JWT after server restart when in-memory session was cleared but token is still valid. */
export function acceptStaffSessionToken(userId, sessionToken) {
  const activeToken = getStaffSession(userId)
  if (!activeToken) {
    createStaffSession(userId, sessionToken)
    return true
  }
  return activeToken === sessionToken
}

export function clearStaffSession(userId) {
  staffSessions.delete(userId)
}
