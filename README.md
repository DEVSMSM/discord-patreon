# discord-patreon

A Node.js package for integrating Patreon membership events with Discord, enabling automatic role management based on patron status.

[![npm version](https://img.shields.io/npm/v/discord-patreon.svg)](https://www.npmjs.com/package/discord-patreon)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

## Features

- ✅ **Track Patreon Memberships**: Monitor new subscriptions, cancellations, and payment status
- ✅ **Discord Integration**: Automatically retrieve linked Discord user IDs from Patreon
- ✅ **Status Tracking**: Track active, declined, and cancelled memberships
- ✅ **Event System**: Event-based architecture for easy integration
- ✅ **Persistent Cache**: Prevent duplicate events even across application restarts
- ✅ **Webhook-Compatible**: Can be integrated with Discord webhooks for notifications

## Installation

```bash
npm install discord-patreon
```

Or with Yarn:

```bash
yarn add discord-patreon
```

## Quick Start

```javascript
const { PatreonEvents } = require('discord-patreon');

// Initialize with your credentials
const patreon = new PatreonEvents({
  accessToken: 'your-patreon-access-token',
  campaignId: 'your-campaign-id'
});

// Subscribe to events
patreon.on('ready', () => {
  console.log('Patreon monitoring started!');
});

patreon.on('subscribed', (member) => {
  console.log(`New patron: ${member.fullName} (${member.id})`);
  console.log(`Discord ID: ${member.discordId || 'Not connected'}`);
});

// Start monitoring
patreon.initialize();
```

## Complete Configuration Options

```javascript
const patreon = new PatreonEvents({
  // Required configuration
  accessToken: 'your-patreon-access-token',
  campaignId: 'your-campaign-id',
  
  // Optional configuration
  checkInterval: 60000,         // How often to check for updates (ms), default: 60000 (1 minute)
  cacheFile: './patreon-cache.json', // Custom cache file path
  cacheSaveInterval: 300000     // How often to save cache (ms), default: 300000 (5 minutes)
});
```

## Available Events

| Event | Description | Parameter |
|-------|-------------|-----------|
| `ready` | Emitted when monitoring has started | None |
| `subscribed` | Emitted when a new patron subscribes | Patron data object |
| `canceled` | Emitted when a patron cancels their subscription | Patron data object |
| `declined` | Emitted when a patron's payment is declined | Patron data object |
| `reactivated` | Emitted when a canceled patron reactivates | Patron data object |
| `connected` | Emitted when a patron connects their Discord account | Patron data object |
| `disconnected` | Emitted when a patron disconnects their Discord account | Patron data object |
| `expired` | Emitted when a membership expires | Patron data object |
| `error` | Emitted when an error occurs | Error object |

## Patron Data Structure

Each patron object contains:

```typescript
{
  id: string;                 // Patreon member ID
  status: string;             // Status: active_patron, declined_patron, former_patron
  fullName?: string;          // Patron's full name (if available)
  email?: string;             // Patron's email (if available)
  patronStatus?: string;      // Detailed patron status
  pledgeAmount?: number;      // Amount in dollars (if available)
  discordId: string | null;   // Discord user ID (if connected)
  joinedAt?: string;          // When they became a patron
  expiresAt?: string;         // When their current pledge expires
  relationships?: any;        // Raw relationships data from Patreon API
}
```

## Advanced Usage Examples

### Discord Role Management

```javascript
const { Client, GatewayIntentBits } = require('discord.js');
const { PatreonEvents } = require('discord-patreon');

// Initialize Discord client
const client = new Client({ 
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// Initialize Patreon events
const patreon = new PatreonEvents({
  accessToken: 'your-patreon-access-token',
  campaignId: 'your-campaign-id',
  cacheFile: './patreon-cache.json'
});

// Set up role management functions
async function addPatronRole(discordId) {
  const guild = client.guilds.cache.get('your-guild-id');
  if (!guild) return;
  
  try {
    const member = await guild.members.fetch(discordId);
    if (member) {
      await member.roles.add('patron-role-id');
      console.log(`Added patron role to ${member.user.tag}`);
    }
  } catch (error) {
    console.error(`Failed to add role: ${error.message}`);
  }
}

async function removePatronRole(discordId) {
  const guild = client.guilds.cache.get('your-guild-id');
  if (!guild) return;
  
  try {
    const member = await guild.members.fetch(discordId);
    if (member) {
      await member.roles.remove('patron-role-id');
      console.log(`Removed patron role from ${member.user.tag}`);
    }
  } catch (error) {
    console.error(`Failed to remove role: ${error.message}`);
  }
}

// Handle Patreon events
patreon.on('ready', () => {
  console.log('Patreon monitoring started!');
});

patreon.on('subscribed', (member) => {
  console.log(`New patron: ${member.fullName}`);
  if (member.discordId) {
    addPatronRole(member.discordId);
  }
});

patreon.on('connected', (member) => {
  console.log(`Patron connected Discord: ${member.discordId}`);
  addPatronRole(member.discordId);
});

patreon.on('canceled', (member) => {
  console.log(`Patron canceled: ${member.fullName}`);
  if (member.discordId) {
    removePatronRole(member.discordId);
  }
});

patreon.on('declined', (member) => {
  console.log(`Patron payment declined: ${member.fullName}`);
  if (member.discordId) {
    removePatronRole(member.discordId);
  }
});

patreon.on('disconnected', (member) => {
  console.log(`Patron disconnected Discord: ${member.discordId}`);
  removePatronRole(member.discordId);
});

// Start both systems
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  patreon.initialize();
});

client.login('your-discord-bot-token');
```

### Lookup Patrons by Discord ID

```javascript
const { PatreonEvents } = require('discord-patreon');

const patreon = new PatreonEvents({
  accessToken: 'your-patreon-access-token',
  campaignId: 'your-campaign-id'
});

// Initialize and wait for ready event
patreon.on('ready', () => {
  // Now you can look up patrons by Discord ID
  const checkPatronStatus = (discordId) => {
    const patron = patreon.users.get(discordId);
    
    if (patron) {
      console.log(`Found patron: ${patron.fullName}`);
      console.log(`Status: ${patron.status}`);
      console.log(`Pledge amount: $${patron.pledgeAmount || 'unknown'}`);
      return true;
    } else {
      console.log(`No patron found with Discord ID: ${discordId}`);
      return false;
    }
  };
  
  // Example usage
  checkPatronStatus('559253955230695426');
});

patreon.initialize();
```

## Persistent Cache

The package includes a robust caching system that:

1. Prevents duplicate events across application restarts
2. Tracks Discord ID connections and disconnections
3. Maintains a history of membership status changes

This ensures your application won't send duplicate welcome messages or assign roles multiple times.

```javascript
// Configure with a cache file
const patreon = new PatreonEvents({
  accessToken: 'your-patreon-access-token',
  campaignId: 'your-campaign-id',
  cacheFile: './data/patreon-cache.json' // Custom location
});

// The cache will be saved automatically and loaded on restart
```

## Important Notes

### Patreon API Access

To use this package, you need:

1. A Patreon Creator account
2. A Patreon API Client (create one at https://www.patreon.com/portal/registration/register-clients)
3. An access token with the following scopes:
   - `identity`
   - `identity[email]`
   - `campaigns`
   - `campaigns.members`
   - `campaigns.members.address`
   - `campaigns.members[email]`

### Rate Limits

Patreon has API rate limits. To avoid hitting these limits:

- Use a reasonable `checkInterval` (60000ms or higher recommended)

## Proper Shutdown

To ensure the cache is saved properly before your application exits:

```javascript
// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  patreon.stop(); // This saves the cache and cleans up
  process.exit(0);
});
```

## Troubleshooting

### API Error: 401 Unauthorized

- Your access token may be invalid or expired
- Ensure you have the required scopes enabled for your token

### Events Not Firing

- Check that you've called `initialize()` after setting up event listeners
- Verify your campaign ID is correct
- Ensure your access token has the necessary permissions

### Discord IDs Not Being Retrieved

- Confirm that your patrons have connected their Discord accounts to Patreon
- Ensure your access token has the `identity` scope

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

ISC

## Support

For questions or support, please contact: `devszero` on Discord.

## Stability Notice

**IMPORTANT**: This package is currently in early development. You may encounter bugs or changes to the API in future versions. Error handling for edge cases is still being refined, and some features might not work as expected with all Patreon account configurations. Please report any issues on the GitHub repository.
