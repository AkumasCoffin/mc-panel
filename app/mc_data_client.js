// mc_data_client.js - Client for communicating with MC Panel Data Collector
const https = require('https');
const http = require('http');

class McDataClient {
    constructor(options = {}) {
        this.host = options.host || process.env.MC_DATA_HOST || 'localhost';
        this.port = options.port || process.env.MC_DATA_PORT || 25580;
        this.protocol = options.protocol || 'http';
        this.timeout = options.timeout || 5000;
        this.enabled = options.enabled !== false; // Default to enabled
        
        console.log(`MC Data Client configured: ${this.protocol}://${this.host}:${this.port}`);
    }
    
    async fetchData(endpoint = 'all') {
        if (!this.enabled) {
            throw new Error('MC Data Client is disabled');
        }
        
        return new Promise((resolve, reject) => {
            const httpModule = this.protocol === 'https' ? https : http;
            const url = `${this.protocol}://${this.host}:${this.port}/api/${endpoint}`;
            
            const request = httpModule.get(url, {
                timeout: this.timeout
            }, (response) => {
                let data = '';
                
                response.on('data', (chunk) => {
                    data += chunk;
                });
                
                response.on('end', () => {
                    try {
                        const jsonData = JSON.parse(data);
                        resolve(jsonData);
                    } catch (error) {
                        reject(new Error(`Failed to parse JSON response: ${error.message}`));
                    }
                });
            });
            
            request.on('timeout', () => {
                request.destroy();
                reject(new Error(`Request timeout after ${this.timeout}ms`));
            });
            
            request.on('error', (error) => {
                reject(new Error(`Request failed: ${error.message}`));
            });
        });
    }
    
    // Convenience methods for specific data types
    async getStatus() {
        return this.fetchData('status');
    }
    
    async getAllData() {
        return this.fetchData('all');
    }
    
    async getPlayerData() {
        return this.fetchData('players');
    }
    
    async getWorldData() {
        return this.fetchData('world');
    }
    
    async getPerformanceData() {
        return this.fetchData('performance');
    }
    
    async getModData() {
        return this.fetchData('mods');
    }
    
    async getSecurityData() {
        return this.fetchData('security');
    }
    
    async getMiscData() {
        return this.fetchData('misc');
    }
    
    // Check if the data collector is available
    async isAvailable() {
        try {
            await this.getStatus();
            return true;
        } catch (error) {
            return false;
        }
    }
    
    // Get formatted summary for dashboard
    async getSummary() {
        try {
            const [players, world, performance, status] = await Promise.all([
                this.getPlayerData(),
                this.getWorldData(),
                this.getPerformanceData(),
                this.getStatus()
            ]);
            
            return {
                available: true,
                last_update: status.last_update,
                players: {
                    online: players.online_count || 0,
                    max: players.max_players || 20
                },
                performance: {
                    tps: performance.ticks?.tps || 0,
                    memory_usage: performance.memory?.heap_usage_percent || 0,
                    cpu_load: performance.cpu?.load_average || 0
                },
                world: {
                    time: world.worlds?.[0]?.time || 0,
                    is_day: world.worlds?.[0]?.is_day || false,
                    weather: {
                        raining: world.worlds?.[0]?.is_raining || false,
                        thundering: world.worlds?.[0]?.is_thundering || false
                    }
                }
            };
        } catch (error) {
            return {
                available: false,
                error: error.message
            };
        }
    }
}

module.exports = McDataClient;