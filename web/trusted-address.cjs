/**
 * The browser's address, as the web server can vouch for it (Phase 80).
 *
 * Kong limits requests per address, and every browser reaches Kong through this server, so
 * the server tells Kong whose request it is in `X-Forwarded-For`. Next keeps an
 * `X-Forwarded-For` the browser sent, so the header cannot be passed on as it came: this
 * module, preloaded with `node --require`, sets it before Next reads it.
 *
 * `HORIZON_WEB_TRUSTED_HOPS` is the number of proxies in front of this server that append
 * the address they saw (0 when browsers connect directly). The address is the one the
 * outermost trusted proxy saw; anything further left was written by the browser.
 */
const http = require('node:http')
const { isIP } = require('node:net')

/** The client's address from the forwarded chain, the socket's address and the trusted hops. */
function clientAddress(forwardedFor, socketAddress, hops) {
  const chain = [
    ...String(forwardedFor ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    socketAddress,
  ]
  const index = chain.length - 1 - hops
  // Fewer entries than trusted proxies: every entry was written by a trusted hop.
  const candidate = plain(chain[Math.max(index, 0)])
  return isIP(candidate) ? candidate : plain(socketAddress)
}

/** An IPv4 address mapped into IPv6 is written as the IPv4 address it is. */
function plain(address) {
  const value = String(address ?? '')
  return value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value
}

function trustedHops(value) {
  const hops = Number(value ?? 0)
  if (!Number.isInteger(hops) || hops < 0 || hops > 5)
    throw new Error('HORIZON_WEB_TRUSTED_HOPS must be an integer from 0 to 5')
  return hops
}

function install() {
  const hops = trustedHops(process.env.HORIZON_WEB_TRUSTED_HOPS)
  const createServer = http.createServer
  http.createServer = function trustedCreateServer(...args) {
    const index = args.findIndex((arg) => typeof arg === 'function')
    if (index !== -1) {
      const listener = args[index]
      args[index] = function trustedListener(request, response) {
        request.headers['x-forwarded-for'] = clientAddress(
          request.headers['x-forwarded-for'],
          request.socket.remoteAddress,
          hops,
        )
        return listener.call(this, request, response)
      }
    }
    return createServer.apply(this, args)
  }
}

if (!process.env.VITEST) install()

module.exports = { clientAddress, trustedHops }
