import { EventEmitter } from "events";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";

// Interface for the Patreon options
interface PatreonOptions {
    accessToken: string;
    campaignId: string;
    checkInterval?: number; // How often to check for updates (default: 60000ms)
    cacheFile?: string; // Path to a custom cache file
    cacheSaveInterval?: number; // Optional interval for saving cache (default: 5 minutes)
}

// Enhanced cache data structure to track all event types
interface CacheData {
    lastUpdated: number;
    memberships: Record<string, string>; // id -> status
    discordIds: Record<string, string | null>; // id -> discordId
    // Event tracking to prevent duplicate events
    subscribedMembers: string[]; // ids of members who have had 'subscribed' event
    canceledMembers: Record<string, number>; // id -> timestamp of cancellation
    declinedMembers: Record<string, number>; // id -> timestamp of decline
    reactivatedMembers: Record<string, number>; // id -> timestamp of reactivation 
    connectedDiscords: Record<string, string>; // id -> discordId of connection
    disconnectedDiscords: Record<string, string>; // id -> discordId of disconnection
}

// Membership Interface
interface MembershipData {
    id: string;
    status: string; // active, declined, canceled
    fullName?: string;
    email?: string;
    patronStatus?: string;
    pledgeAmount?: number;
    discordId: string | null;
    joinedAt?: string;
    expiresAt?: string;
    relationships?: any;
}

// Event types for better type safety
interface PatreonEventMap {
    subscribed: (data: MembershipData) => void;
    connected: (data: MembershipData) => void;
    canceled: (data: MembershipData) => void;
    declined: (data: MembershipData) => void;
    reactivated: (data: MembershipData) => void;
    disconnected: (data: MembershipData) => void;
    expired: (data: MembershipData) => void; // New event for expired subscriptions
    error: (error: Error) => void;
    ready: () => void; // New event for initialization completion
}

/**
 * PatreonEvents class - Monitors Patreon memberships and emits events on changes
 * Works with both ESM and CommonJS
 */
class PatreonEvents extends EventEmitter {
    private accessToken: string;
    private lastMemberships: Map<string, string>; // Status tracking
    private lastDiscordIds: Map<string, string | null>; // Discord ID tracking
    private campaignId: string;
    private intervalId: NodeJS.Timeout | null = null;
    private cacheSaveIntervalId: NodeJS.Timeout | null = null;
    private isFirstRun: boolean = true; // Add flag to track first run
    private cacheSaveInterval: number;
    private cacheFile: string;
    private checkInterval: number;

    // Event tracking sets and maps
    private subscribedMembers: Set<string> = new Set();
    private canceledMembers: Map<string, number> = new Map();
    private declinedMembers: Map<string, number> = new Map();
    private reactivatedMembers: Map<string, number> = new Map();
    private connectedDiscords: Map<string, string> = new Map();
    private disconnectedDiscords: Map<string, string> = new Map();
    
    // User lookup by Discord ID
    private discordToMemberMap: Map<string, MembershipData> = new Map();
    
    // Public interface for user access
    public users = {
        get: (discordId: string): MembershipData | null => {
            return this.getByDiscordId(discordId);
        }
    };
    
    constructor(options: PatreonOptions) {
        super();
        this.accessToken = options.accessToken;
        this.campaignId = options.campaignId;
        this.checkInterval = options.checkInterval || 60000; // Default to checking every minute
        this.cacheSaveInterval = options.cacheSaveInterval || 300000; // Default to 5 minutes
        this.cacheFile = options.cacheFile ? 
            path.resolve(options.cacheFile) : 
            path.resolve(__dirname, "data.json"); // Use custom path or default
        this.lastMemberships = new Map();
        this.lastDiscordIds = new Map(); // Track Discord IDs separately
        
        // Load cache from the configured file
        this.loadCache();
    }

    // Type-safe event emitter methods
    emit<K extends keyof PatreonEventMap>(event: K, ...args: Parameters<PatreonEventMap[K]>): boolean {
        return super.emit(event, ...args);
    }

    on<K extends keyof PatreonEventMap>(event: K, listener: PatreonEventMap[K]): this {
        return super.on(event, listener as (...args: any[]) => void);
    }

    once<K extends keyof PatreonEventMap>(event: K, listener: PatreonEventMap[K]): this {
        return super.once(event, listener as (...args: any[]) => void);
    }

    off<K extends keyof PatreonEventMap>(event: K, listener: PatreonEventMap[K]): this {
        return super.off(event, listener as (...args: any[]) => void);
    }

    /**
     * Load cache data from the hardcoded file
     */
    private loadCache(): void {
        try {
            // Check if cache file exists
            if (fs.existsSync(this.cacheFile)) {
                const cacheData = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) as CacheData;
                
                // Load membership statuses
                if (cacheData.memberships) {
                    this.lastMemberships = new Map(Object.entries(cacheData.memberships));
                }
                
                // Load Discord IDs
                if (cacheData.discordIds) {
                    this.lastDiscordIds = new Map(Object.entries(cacheData.discordIds));
                }
                
                // Load event tracking data
                if (cacheData.subscribedMembers) {
                    this.subscribedMembers = new Set(cacheData.subscribedMembers);
                }
                
                if (cacheData.canceledMembers) {
                    this.canceledMembers = new Map(Object.entries(cacheData.canceledMembers)
                        .map(([key, value]) => [key, Number(value)]));
                }
                
                if (cacheData.declinedMembers) {
                    this.declinedMembers = new Map(Object.entries(cacheData.declinedMembers)
                        .map(([key, value]) => [key, Number(value)]));
                }
                
                if (cacheData.reactivatedMembers) {
                    this.reactivatedMembers = new Map(Object.entries(cacheData.reactivatedMembers)
                        .map(([key, value]) => [key, Number(value)]));
                }
                
                if (cacheData.connectedDiscords) {
                    this.connectedDiscords = new Map(Object.entries(cacheData.connectedDiscords));
                }
                
                if (cacheData.disconnectedDiscords) {
                    this.disconnectedDiscords = new Map(Object.entries(cacheData.disconnectedDiscords));
                }
                
                console.log(`Loaded cache from ${this.cacheFile}, with ${this.lastMemberships.size} memberships`);
            }
        } catch (error) {
            console.warn(`Failed to load cache file: ${error}`);
            // Continue without cache, it will be created on next save
        }
    }
    
    /**
     * Save current state to the hardcoded cache file
     */
    private saveCache(): void {
        try {
            // Ensure the directory exists
            const directory = path.dirname(this.cacheFile);
            if (!fs.existsSync(directory)) {
                fs.mkdirSync(directory, { recursive: true });
            }
            
            // Convert Maps and Sets to objects/arrays for JSON serialization
            const cacheData: CacheData = {
                lastUpdated: Date.now(),
                memberships: Object.fromEntries(this.lastMemberships),
                discordIds: Object.fromEntries(this.lastDiscordIds),
                subscribedMembers: Array.from(this.subscribedMembers),
                canceledMembers: Object.fromEntries(this.canceledMembers),
                declinedMembers: Object.fromEntries(this.declinedMembers),
                reactivatedMembers: Object.fromEntries(this.reactivatedMembers),
                connectedDiscords: Object.fromEntries(this.connectedDiscords),
                disconnectedDiscords: Object.fromEntries(this.disconnectedDiscords)
            };
            
            fs.writeFileSync(this.cacheFile, JSON.stringify(cacheData, null, 2));
        } catch (error) {
            console.error(`Failed to save cache: ${error}`);
        }
    }
  
    async fetchMemberships(): Promise<MembershipData[]> {
        try {
            // Patreon API V2 requires specific field formats
            // Use safe default fields that are known to be valid
            const defaultMemberFields = [
                'patron_status', 
                'full_name', 
                'email', 
                'pledge_relationship_start', 
                'will_pay_amount_cents', 
                'next_charge_date'  // Add field for expiration date
            ];
            
            const response = await axios.get(`https://www.patreon.com/api/oauth2/v2/campaigns/${this.campaignId}/members`, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Accept': 'application/json'
                },
                params: {
                    // Always include user to get Discord ID and other social connections
                    'include': 'user,currently_entitled_tiers',
                    // Only use verified fields for member
                    'fields[member]': defaultMemberFields.join(','),
                    // Explicitly request social connections to get Discord ID
                    'fields[user]': 'social_connections',
                    // Get tier info
                    'fields[tier]': 'title,amount_cents'
                }
            });
               
            // Extract members from the response
            if (!response?.data?.data || !Array.isArray(response.data.data)) {
                console.warn("Unexpected response structure:", response.data);
                return [];
            }
            
            return response.data.data.map((member: any) => {
                // Find the user data from included resources
                const userData = response.data.included?.find((inc: any) => 
                    inc.type === 'user' && inc.id === member.relationships?.user?.data?.id);
                
                // Find tier data if available
                const tierData = response.data.included?.find((inc: any) => 
                    inc.type === 'tier' && member.relationships?.currently_entitled_tiers?.data?.[0]?.id === inc.id);
                
                // Extract Discord ID (prioritized field)
                const discordId = userData?.attributes?.social_connections?.discord?.user_id || null;
                
                return {
                    id: member.id,
                    status: member.attributes?.patron_status || 'none',
                    fullName: member.attributes?.full_name,
                    email: member.attributes?.email,
                    patronStatus: member.attributes?.patron_status,
                    // Always include Discord ID (even if null)
                    discordId,
                    // Get pledge amount from tier if available
                    pledgeAmount: tierData?.attributes?.amount_cents ? 
                        tierData.attributes.amount_cents / 100 : undefined,
                    joinedAt: member.attributes?.pledge_relationship_start,
                    // Include expiration date (next charge date)
                    expiresAt: member.attributes?.next_charge_date,
                    // Include the raw relationships for advanced usage
                    relationships: member.relationships
                };
            });
        } catch (error) {
            if (axios.isAxiosError(error) && error.response) {
                // Log the actual error message from Patreon
                console.error("Patreon API Error Details:", {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: JSON.stringify(error.response.data, null, 2)
                });
            } else {
                console.error("Unexpected error:", error);
            }
            
            this.emit("error", error instanceof Error ? error : new Error(String(error)));
            return [];
        }
    }

    /**
     * Emit event and track it in cache
     */
    private emitAndTrack<K extends keyof PatreonEventMap>(
        event: K, 
        data: Parameters<PatreonEventMap[K]>[0], 
        shouldTrack: boolean = true
    ): boolean {
        // If we're not tracking or this is a non-member event, just emit
        if (!shouldTrack || event === 'error' || event === 'ready') {
            return super.emit(event, data);
        }
        
        // For member events, track them based on event type
        const member = data as unknown as MembershipData;
        const now = Date.now();
        
        switch (event) {
            case 'subscribed':
                this.subscribedMembers.add(member.id);
                // Remove canceled or declined data if the user subscribes again
                if (this.canceledMembers.has(member.id)) {
                    this.canceledMembers.delete(member.id);
                    console.log(`Removed canceled data for Patron ${member.id} as they subscribed again`);
                }
                if (this.declinedMembers.has(member.id)) {
                    this.declinedMembers.delete(member.id);
                    console.log(`Removed declined data for Patron ${member.id} as they subscribed again`);
                }
                break;
            case 'reactivated':
                this.reactivatedMembers.set(member.id, now);
                // Remove canceled or declined data if the user reactivates their membership
                if (this.canceledMembers.has(member.id)) {
                    this.canceledMembers.delete(member.id);
                    console.log(`Removed canceled data for Patron ${member.id} as they reactivated their membership`);
                }
                if (this.declinedMembers.has(member.id)) {
                    this.declinedMembers.delete(member.id);
                    console.log(`Removed declined data for Patron ${member.id} as they reactivated their membership`);
                }
                break;
            case 'canceled':
                this.canceledMembers.set(member.id, now);
                // Remove subscribed or reactivated data if the user cancels their membership
                if (this.subscribedMembers.has(member.id)) {
                    this.subscribedMembers.delete(member.id);
                    console.log(`Removed subscribed data for Patron ${member.id} as they canceled their membership`);
                }
                if (this.reactivatedMembers.has(member.id)) {
                    this.reactivatedMembers.delete(member.id);
                    console.log(`Removed reactivated data for Patron ${member.id} as they canceled their membership`);
                }
                break;
            case 'declined':
                this.declinedMembers.set(member.id, now);
                // Remove subscribed or reactivated data if the user declines their membership
                if (this.subscribedMembers.has(member.id)) {
                    this.subscribedMembers.delete(member.id);
                    console.log(`Removed subscribed data for Patron ${member.id} as they declined their membership`);
                }
                if (this.reactivatedMembers.has(member.id)) {
                    this.reactivatedMembers.delete(member.id);
                    console.log(`Removed reactivated data for Patron ${member.id} as they declined their membership`);
                }
                break;
            case 'connected':
                if (member.discordId) {
                    this.connectedDiscords.set(member.id, member.discordId);
                    // Remove old disconnected data for this user
                    if (this.disconnectedDiscords.has(member.id)) {
                        this.disconnectedDiscords.delete(member.id);
                        console.log(`Removed old disconnected data for Patron ${member.id}`);
                    }
                }
                break;
            case 'disconnected':
                if (member.discordId) {
                    this.disconnectedDiscords.set(member.id, member.discordId);
                    // Remove old connected data for this user
                    if (this.connectedDiscords.has(member.id)) {
                        this.connectedDiscords.delete(member.id);
                        console.log(`Removed old connected data for Patron ${member.id}`);
                    }
                }
                break;
            case 'expired':
                // Remove the user from subscribedMembers when their subscription expires
                if (this.subscribedMembers.has(member.id)) {
                    this.subscribedMembers.delete(member.id);
                    console.log(`Removed Patron ${member.id} from subscribedMembers due to expired subscription`);
                }
                break;
        }
        
        // After tracking, emit the event
        return super.emit(event, data);
    }

    /**
     * Check if an event has already been processed (to prevent duplicates)
     */
    private hasProcessedEvent(event: string, member: MembershipData): boolean {
        switch (event) {
            case 'subscribed':
                return this.subscribedMembers.has(member.id);
            case 'connected':
                return this.connectedDiscords.has(member.id) && 
                       this.connectedDiscords.get(member.id) === member.discordId;
            case 'disconnected':
                return this.disconnectedDiscords.has(member.id) && 
                       this.disconnectedDiscords.get(member.id) === member.discordId;
            // Other events are time-based and should be re-emitted if they happen again
            default:
                return false;
        }
    }

    async checkForUpdates(): Promise<void> {
        try {
            const memberships = await this.fetchMemberships();
            const currentMembers = new Set(memberships.map(member => member.id));
            
            // Reset the Discord ID map for refresh
            this.discordToMemberMap.clear();
            
            // Track current Discord IDs for disconnection detection
            const currentDiscordConnections = new Map<string, string | null>();

            memberships.forEach((member) => {
                const { id, status, discordId } = member;
                const previousStatus = this.lastMemberships.get(id);
                const previousDiscordId = this.lastDiscordIds.get(id);
                
                // Update the Discord ID to member mapping if the member has a Discord ID
                if (discordId) {
                    this.discordToMemberMap.set(discordId, member);
                }
                
                // Track this member's Discord connection
                currentDiscordConnections.set(id, discordId);

                // Membership status changes (not related to Discord connection)
                if (!previousStatus) {
                    // New member - only emit subscribed event if this isn't the first run
                    // and we haven't already processed this subscription
                    if (!this.isFirstRun && !this.hasProcessedEvent('subscribed', member)) {
                        this.emitAndTrack("subscribed", member);
                    }
                } else if (previousStatus !== status) {
                    // Status changes can happen multiple times, so always emit them
                    if (status === "canceled") this.emitAndTrack("canceled", member);
                    if (status === "declined") this.emitAndTrack("declined", member);
                    if (status === "active" && 
                        (previousStatus === "canceled" || previousStatus === "declined")) {
                        this.emitAndTrack("reactivated", member);
                    }
                    if (status === "none") {
                        // Emit expired event if the membership status becomes "none"
                        this.emitAndTrack("expired", member);
                    }
                }
                
                // Discord connection changes - focus specifically on Discord linking/unlinking
                if (previousDiscordId === undefined || previousDiscordId === null) {
                    // No previous Discord ID
                    if (discordId && !this.hasProcessedEvent('connected', member)) {
                        // New Discord connection that we haven't processed yet
                        this.emitAndTrack("connected", member);
                    }
                } else {
                    // Had a Discord ID before
                    if (!discordId) {
                        // Discord disconnected - create a record with the previous ID
                        const disconnectMember = {
                            ...member,
                            discordId: previousDiscordId // Use the previous ID since current is null
                        };
                        
                        if (!this.hasProcessedEvent('disconnected', disconnectMember)) {
                            this.emitAndTrack("disconnected", disconnectMember);
                        }
                    } else if (previousDiscordId !== discordId) {
                        // Discord ID changed (account changed) - handle as disconnect + connect
                        const disconnectMember = {
                            ...member,
                            discordId: previousDiscordId
                        };
                        
                        if (!this.hasProcessedEvent('disconnected', disconnectMember)) {
                            this.emitAndTrack("disconnected", disconnectMember);
                        }
                        
                        if (!this.hasProcessedEvent('connected', member)) {
                            this.emitAndTrack("connected", member);
                        }
                    }
                }
                
                // Update our tracking
                this.lastMemberships.set(id, status);
                this.lastDiscordIds.set(id, discordId);
            });

            // Detect removed members
            for (const id of this.lastMemberships.keys()) {
                if (!currentMembers.has(id)) {
                    const lastKnownStatus = this.lastMemberships.get(id) || 'none';
                    const lastKnownDiscordId = this.lastDiscordIds.get(id);
                    
                    // If they had a Discord connection when they left, emit disconnect
                    if (lastKnownDiscordId) {
                        const disconnectMember = { 
                            id, 
                            status: lastKnownStatus,
                            discordId: lastKnownDiscordId
                        };
                        
                        if (!this.hasProcessedEvent('disconnected', disconnectMember)) {
                            this.emitAndTrack("disconnected", disconnectMember);
                        }
                    }
                    
                    // Clean up our maps
                    this.lastMemberships.delete(id);
                    this.lastDiscordIds.delete(id);
                }
            }

            // After processing, mark first run as complete
            this.isFirstRun = false;
            
            // Save cache after updates if cache file is configured
            this.saveCache();
        } catch (error) {
            this.emit("error", error instanceof Error ? error : new Error(String(error)));
        }
    }

    /**
     * Get a patron by their Discord ID
     * @param discordId The Discord user ID to look up
     * @returns MembershipData object if found, null otherwise
     */
    private getByDiscordId(discordId: string): MembershipData | null {
        // Standardize the Discord ID format
        const normalizedDiscordId = discordId.trim();
        return this.discordToMemberMap.get(normalizedDiscordId) || null;
    }

    /**
     * Initialize the Patreon events monitoring
     * Emits 'ready' event when the first check is complete
     */
    initialize(): void {
        // Initial data check
        this.checkForUpdates().then(() => {
            // Set up regular interval using the configured checkInterval
            this.intervalId = setInterval(() => this.checkForUpdates(), this.checkInterval);
            
            // Set up regular cache saving
            this.cacheSaveIntervalId = setInterval(() => this.saveCache(), this.cacheSaveInterval);
            
            this.emit('ready');
        }).catch(error => {
            this.emit('error', error instanceof Error ? error : new Error(String(error)));
        });
    }

    /**
     * Restart the Patreon events monitoring
     * Clears the current interval and starts a new one
     */
    restart(): void {
        // Clear existing intervals
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        
        if (this.cacheSaveIntervalId) {
            clearInterval(this.cacheSaveIntervalId);
            this.cacheSaveIntervalId = null;
        }
        
        // Save cache before restarting
        this.saveCache();
        
        // Start a fresh check cycle
        this.initialize();
    }
    
    /**
     * Stop monitoring and clean up resources
     */
    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        
        if (this.cacheSaveIntervalId) {
            clearInterval(this.cacheSaveIntervalId);
            this.cacheSaveIntervalId = null;
        }
        
        // Save cache on shutdown
        this.saveCache();
        
        // Remove all listeners
        this.removeAllListeners();
    }
}

// Export for both ESM and CommonJS
export { PatreonEvents, PatreonOptions, MembershipData, PatreonEventMap };
export default PatreonEvents;