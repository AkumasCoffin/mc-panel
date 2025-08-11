// system_monitor.js - System metrics collection for dashboard
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

class SystemMonitor {
  constructor() {
    this.metrics = {
      cpu: { usage: 0, cores: os.cpus().length },
      memory: { used: 0, total: 0, free: 0, usage: 0 },
      disk: { used: 0, total: 0, free: 0, usage: 0 },
      network: { rx: 0, tx: 0, rxRate: 0, txRate: 0 },
      uptime: 0,
      load: { 1: 0, 5: 0, 15: 0 }
    };
    this.lastNetworkStats = null;
    this.lastNetworkTime = null;
  }

  // Get CPU usage percentage
  getCpuUsage() {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    return {
      usage: Math.round(100 - (100 * totalIdle / totalTick)),
      cores: cpus.length
    };
  }

  // Get memory usage
  getMemoryUsage() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    
    return {
      used: Math.round(used / 1024 / 1024), // MB
      total: Math.round(total / 1024 / 1024), // MB
      free: Math.round(free / 1024 / 1024), // MB
      usage: Math.round((used / total) * 100)
    };
  }

  // Get disk usage (for root filesystem)
  getDiskUsage() {
    try {
      const output = execSync('df / | tail -1', { encoding: 'utf8' });
      const parts = output.trim().split(/\s+/);
      const total = parseInt(parts[1]) * 1024; // Convert from KB to bytes
      const used = parseInt(parts[2]) * 1024;
      const available = parseInt(parts[3]) * 1024;
      
      return {
        used: Math.round(used / 1024 / 1024), // MB
        total: Math.round(total / 1024 / 1024), // MB
        free: Math.round(available / 1024 / 1024), // MB
        usage: Math.round((used / total) * 100)
      };
    } catch (e) {
      return { used: 0, total: 0, free: 0, usage: 0 };
    }
  }

  // Get network usage
  getNetworkUsage() {
    try {
      const interfaces = os.networkInterfaces();
      let totalRx = 0;
      let totalTx = 0;

      // Try to read from /proc/net/dev for more accurate stats
      try {
        const netData = fs.readFileSync('/proc/net/dev', 'utf8');
        const lines = netData.split('\n');
        
        for (const line of lines) {
          if (line.includes(':') && !line.includes('lo:')) { // Skip loopback
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 10) {
              totalRx += parseInt(parts[1]) || 0; // RX bytes
              totalTx += parseInt(parts[9]) || 0; // TX bytes
            }
          }
        }
      } catch (e) {
        // Fallback to basic calculation if /proc/net/dev is not available
        return { rx: 0, tx: 0, rxRate: 0, txRate: 0 };
      }

      const currentTime = Date.now();
      let rxRate = 0;
      let txRate = 0;

      if (this.lastNetworkStats && this.lastNetworkTime) {
        const timeDiff = (currentTime - this.lastNetworkTime) / 1000; // seconds
        rxRate = Math.round((totalRx - this.lastNetworkStats.rx) / timeDiff); // bytes/sec
        txRate = Math.round((totalTx - this.lastNetworkStats.tx) / timeDiff); // bytes/sec
      }

      this.lastNetworkStats = { rx: totalRx, tx: totalTx };
      this.lastNetworkTime = currentTime;

      return {
        rx: Math.round(totalRx / 1024 / 1024), // MB total
        tx: Math.round(totalTx / 1024 / 1024), // MB total
        rxRate: Math.round(rxRate / 1024), // KB/s
        txRate: Math.round(txRate / 1024) // KB/s
      };
    } catch (e) {
      return { rx: 0, tx: 0, rxRate: 0, txRate: 0 };
    }
  }

  // Get system load averages
  getLoadAverage() {
    const loads = os.loadavg();
    return {
      1: Math.round(loads[0] * 100) / 100,
      5: Math.round(loads[1] * 100) / 100,
      15: Math.round(loads[2] * 100) / 100
    };
  }

  // Get system uptime
  getUptime() {
    return Math.round(os.uptime());
  }

  // Collect all metrics
  async collectMetrics() {
    this.metrics = {
      cpu: this.getCpuUsage(),
      memory: this.getMemoryUsage(),
      disk: this.getDiskUsage(),
      network: this.getNetworkUsage(),
      uptime: this.getUptime(),
      load: this.getLoadAverage(),
      timestamp: new Date().toISOString()
    };

    return this.metrics;
  }

  // Get current metrics
  getMetrics() {
    return this.metrics;
  }

  // Start periodic monitoring
  start(intervalMs = 5000) {
    this.collectMetrics(); // Initial collection
    this.interval = setInterval(() => {
      this.collectMetrics();
    }, intervalMs);
  }

  // Stop monitoring
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

module.exports = SystemMonitor;