// analytics.js - Player and server analytics for dashboard graphs
const { run, get, all } = require('./db');

class Analytics {
  constructor() {
    this.lastAnalyticsUpdate = null;
  }

  // Generate daily player analytics
  async generateDailyAnalytics(date = null) {
    const targetDate = date || new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    
    try {
      // Get unique players for the day
      const uniquePlayers = await get(`
        SELECT COUNT(DISTINCT username) as count 
        FROM players 
        WHERE DATE(first_seen) <= ? AND (last_seen IS NULL OR DATE(last_seen) >= ?)
      `, [targetDate, targetDate]);

      // Get total sessions for the day
      const totalSessions = await get(`
        SELECT COUNT(*) as count 
        FROM sessions 
        WHERE DATE(login_time) = ?
      `, [targetDate]);

      // Get total playtime for the day (in seconds)
      const totalPlaytime = await get(`
        SELECT COALESCE(SUM(duration), 0) as total 
        FROM sessions 
        WHERE DATE(login_time) = ? AND duration IS NOT NULL
      `, [targetDate]);

      // Get peak online players (estimate from sessions)
      const peakOnline = await get(`
        SELECT MAX(concurrent) as peak FROM (
          SELECT COUNT(*) as concurrent
          FROM sessions s1
          WHERE DATE(s1.login_time) = ?
          AND NOT EXISTS (
            SELECT 1 FROM sessions s2 
            WHERE s2.player_id = s1.player_id 
            AND s2.login_time > s1.login_time 
            AND DATE(s2.login_time) = ?
            AND s2.logout_time IS NOT NULL 
            AND s2.logout_time < s1.login_time
          )
          GROUP BY strftime('%H', s1.login_time)
        )
      `, [targetDate, targetDate]);

      // Calculate average session duration
      const avgSessionDuration = totalSessions.count > 0 ? 
        (totalPlaytime.total / totalSessions.count) : 0;

      // Insert or update analytics
      await run(`
        INSERT OR REPLACE INTO player_analytics 
        (date, unique_players, total_sessions, total_playtime, peak_online, avg_session_duration) 
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        targetDate,
        uniquePlayers.count || 0,
        totalSessions.count || 0,
        totalPlaytime.total || 0,
        peakOnline.peak || 0,
        Math.round(avgSessionDuration * 100) / 100
      ]);

      return {
        date: targetDate,
        unique_players: uniquePlayers.count || 0,
        total_sessions: totalSessions.count || 0,
        total_playtime: totalPlaytime.total || 0,
        peak_online: peakOnline.peak || 0,
        avg_session_duration: Math.round(avgSessionDuration * 100) / 100
      };
    } catch (e) {
      console.warn('[analytics] Error generating daily analytics:', e.message);
      return null;
    }
  }

  // Generate analytics for the last N days
  async generateHistoricalAnalytics(days = 30) {
    const results = [];
    const today = new Date();
    
    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      const analytics = await this.generateDailyAnalytics(dateStr);
      if (analytics) {
        results.unshift(analytics); // Add to beginning to maintain chronological order
      }
    }
    
    return results;
  }

  // Get player activity trends
  async getPlayerActivityTrend(days = 7) {
    try {
      const result = await all(`
        SELECT 
          date,
          unique_players,
          total_sessions,
          avg_session_duration,
          peak_online
        FROM player_analytics 
        WHERE date >= date('now', '-${days} days')
        ORDER BY date ASC
      `);
      
      return result;
    } catch (e) {
      console.warn('[analytics] Error getting player activity trend:', e.message);
      return [];
    }
  }

  // Get command usage statistics
  async getCommandStats(days = 30) {
    try {
      const result = await all(`
        SELECT 
          command,
          COUNT(*) as usage_count,
          COUNT(DISTINCT player_id) as unique_users,
          DATE(executed_at) as date
        FROM commands 
        WHERE executed_at >= date('now', '-${days} days')
        GROUP BY command, DATE(executed_at)
        ORDER BY usage_count DESC, date DESC
        LIMIT 50
      `);
      
      return result;
    } catch (e) {
      console.warn('[analytics] Error getting command stats:', e.message);
      return [];
    }
  }

  // Get top players by playtime
  async getTopPlayersByPlaytime(limit = 10) {
    try {
      const result = await all(`
        SELECT 
          username,
          total_playtime,
          first_seen,
          last_seen,
          (SELECT COUNT(*) FROM sessions WHERE player_id = players.id) as session_count
        FROM players 
        WHERE total_playtime > 0
        ORDER BY total_playtime DESC 
        LIMIT ?
      `, [limit]);
      
      return result.map(player => ({
        ...player,
        playtime_hours: Math.round((player.total_playtime / 3600) * 100) / 100
      }));
    } catch (e) {
      console.warn('[analytics] Error getting top players:', e.message);
      return [];
    }
  }

  // Get session length distribution
  async getSessionLengthDistribution() {
    try {
      const result = await all(`
        SELECT 
          CASE 
            WHEN duration < 300 THEN '< 5 min'
            WHEN duration < 1800 THEN '5-30 min'
            WHEN duration < 3600 THEN '30-60 min'
            WHEN duration < 7200 THEN '1-2 hours'
            WHEN duration < 14400 THEN '2-4 hours'
            ELSE '4+ hours'
          END as duration_bucket,
          COUNT(*) as count
        FROM sessions 
        WHERE duration IS NOT NULL AND duration > 0
        GROUP BY duration_bucket
        ORDER BY 
          CASE duration_bucket
            WHEN '< 5 min' THEN 1
            WHEN '5-30 min' THEN 2
            WHEN '30-60 min' THEN 3
            WHEN '1-2 hours' THEN 4
            WHEN '2-4 hours' THEN 5
            WHEN '4+ hours' THEN 6
          END
      `);
      
      return result;
    } catch (e) {
      console.warn('[analytics] Error getting session length distribution:', e.message);
      return [];
    }
  }

  // Get hourly activity pattern
  async getHourlyActivity(days = 7) {
    try {
      const result = await all(`
        SELECT 
          strftime('%H', login_time) as hour,
          COUNT(*) as sessions,
          COUNT(DISTINCT player_id) as unique_players
        FROM sessions 
        WHERE login_time >= datetime('now', '-${days} days')
        GROUP BY strftime('%H', login_time)
        ORDER BY hour
      `);
      
      // Fill in missing hours with 0 values
      const hourlyData = Array.from({ length: 24 }, (_, i) => ({
        hour: i.toString().padStart(2, '0'),
        sessions: 0,
        unique_players: 0
      }));
      
      result.forEach(row => {
        const hourIndex = parseInt(row.hour);
        hourlyData[hourIndex] = {
          hour: row.hour,
          sessions: row.sessions,
          unique_players: row.unique_players
        };
      });
      
      return hourlyData;
    } catch (e) {
      console.warn('[analytics] Error getting hourly activity:', e.message);
      return [];
    }
  }

  // Get recent player joins/leaves
  async getRecentActivity(limit = 20) {
    try {
      const joins = await all(`
        SELECT 
          'join' as type,
          username,
          login_time as timestamp,
          last_ip as ip
        FROM sessions s
        JOIN players p ON s.player_id = p.id
        WHERE login_time >= datetime('now', '-24 hours')
        ORDER BY login_time DESC
        LIMIT ?
      `, [limit]);

      const leaves = await all(`
        SELECT 
          'leave' as type,
          username,
          logout_time as timestamp,
          duration,
          last_ip as ip
        FROM sessions s
        JOIN players p ON s.player_id = p.id
        WHERE logout_time >= datetime('now', '-24 hours')
        AND logout_time IS NOT NULL
        ORDER BY logout_time DESC
        LIMIT ?
      `, [limit]);

      // Combine and sort by timestamp
      const combined = [...joins, ...leaves].sort((a, b) => 
        new Date(b.timestamp) - new Date(a.timestamp)
      );

      return combined.slice(0, limit);
    } catch (e) {
      console.warn('[analytics] Error getting recent activity:', e.message);
      return [];
    }
  }

  // Generate comprehensive dashboard data
  async getDashboardData() {
    try {
      const [
        playerTrend,
        commandStats,
        topPlayers,
        sessionDistribution,
        hourlyActivity,
        recentActivity
      ] = await Promise.all([
        this.getPlayerActivityTrend(7),
        this.getCommandStats(7),
        this.getTopPlayersByPlaytime(5),
        this.getSessionLengthDistribution(),
        this.getHourlyActivity(7),
        this.getRecentActivity(10)
      ]);

      // Get current stats
      const currentStats = await this.getCurrentStats();

      return {
        current_stats: currentStats,
        player_trend: playerTrend,
        command_stats: commandStats,
        top_players: topPlayers,
        session_distribution: sessionDistribution,
        hourly_activity: hourlyActivity,
        recent_activity: recentActivity,
        generated_at: new Date().toISOString()
      };
    } catch (e) {
      console.warn('[analytics] Error generating dashboard data:', e.message);
      return null;
    }
  }

  // Get current server statistics (using in-memory data for online status)
  async getCurrentStats() {
    try {
      const totalPlayers = await get('SELECT COUNT(*) as count FROM players');
      const totalSessions = await get('SELECT COUNT(*) as count FROM sessions');
      const totalPlaytime = await get('SELECT COALESCE(SUM(total_playtime), 0) as total FROM players');
      const avgSessionLength = await get('SELECT COALESCE(AVG(duration), 0) as avg FROM sessions WHERE duration IS NOT NULL');
      
      // Get today's stats
      const today = new Date().toISOString().split('T')[0];
      const todayStats = await get('SELECT * FROM player_analytics WHERE date = ?', [today]);

      return {
        total_players: totalPlayers.count || 0,
        online_players: 0, // Will be updated by server with real-time data
        total_sessions: totalSessions.count || 0,
        total_playtime_hours: Math.round((totalPlaytime.total / 3600) * 100) / 100,
        avg_session_minutes: Math.round((avgSessionLength.avg / 60) * 100) / 100,
        today: todayStats || {
          unique_players: 0,
          total_sessions: 0,
          peak_online: 0,
          avg_session_duration: 0
        }
      };
    } catch (e) {
      console.warn('[analytics] Error getting current stats:', e.message);
      return {};
    }
  }

  // Start periodic analytics generation
  start() {
    console.log('[analytics] Starting periodic analytics generation');
    
    // Generate initial analytics
    this.generateDailyAnalytics();
    
    // Schedule daily analytics generation (run every hour, but only update once per day)
    this.intervalId = setInterval(async () => {
      const today = new Date().toISOString().split('T')[0];
      if (this.lastAnalyticsUpdate !== today) {
        await this.generateDailyAnalytics();
        this.lastAnalyticsUpdate = today;
      }
    }, 3600000); // Every hour
  }

  // Stop periodic analytics
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

module.exports = Analytics;