package com.akumas.mcpanel.collectors;

import net.minecraft.server.MinecraftServer;
import net.minecraftforge.server.ServerLifecycleHooks;

import com.google.gson.JsonObject;

import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryUsage;
import java.lang.management.ThreadMXBean;
import java.lang.management.OperatingSystemMXBean;
import java.lang.management.GarbageCollectorMXBean;

import java.util.List;

public class PerformanceDataCollector {
    private final MinecraftServer server;
    
    public PerformanceDataCollector(MinecraftServer server) {
        this.server = server;
    }
    
    public JsonObject collectData() {
        JsonObject performanceData = new JsonObject();
        
        // Memory information
        JsonObject memory = new JsonObject();
        MemoryMXBean memoryBean = ManagementFactory.getMemoryMXBean();
        MemoryUsage heapUsage = memoryBean.getHeapMemoryUsage();
        MemoryUsage nonHeapUsage = memoryBean.getNonHeapMemoryUsage();
        
        memory.addProperty("heap_used", heapUsage.getUsed());
        memory.addProperty("heap_max", heapUsage.getMax());
        memory.addProperty("heap_committed", heapUsage.getCommitted());
        memory.addProperty("heap_init", heapUsage.getInit());
        memory.addProperty("heap_usage_percent", (double) heapUsage.getUsed() / heapUsage.getMax() * 100.0);
        
        memory.addProperty("non_heap_used", nonHeapUsage.getUsed());
        memory.addProperty("non_heap_max", nonHeapUsage.getMax());
        memory.addProperty("non_heap_committed", nonHeapUsage.getCommitted());
        memory.addProperty("non_heap_init", nonHeapUsage.getInit());
        
        // Garbage collection info
        List<GarbageCollectorMXBean> gcBeans = ManagementFactory.getGarbageCollectorMXBeans();
        long totalGcTime = 0;
        long totalGcCount = 0;
        for (GarbageCollectorMXBean gcBean : gcBeans) {
            totalGcTime += gcBean.getCollectionTime();
            totalGcCount += gcBean.getCollectionCount();
        }
        memory.addProperty("gc_total_time", totalGcTime);
        memory.addProperty("gc_total_count", totalGcCount);
        
        performanceData.add("memory", memory);
        
        // CPU information
        JsonObject cpu = new JsonObject();
        OperatingSystemMXBean osBean = ManagementFactory.getOperatingSystemMXBean();
        
        cpu.addProperty("available_processors", osBean.getAvailableProcessors());
        cpu.addProperty("load_average", osBean.getSystemLoadAverage());
        
        // Try to get more detailed CPU info if available
        try {
            if (osBean instanceof com.sun.management.OperatingSystemMXBean) {
                com.sun.management.OperatingSystemMXBean sunOsBean = 
                    (com.sun.management.OperatingSystemMXBean) osBean;
                cpu.addProperty("process_cpu_load", sunOsBean.getProcessCpuLoad() * 100.0);
                cpu.addProperty("system_cpu_load", sunOsBean.getSystemCpuLoad() * 100.0);
                cpu.addProperty("process_cpu_time", sunOsBean.getProcessCpuTime());
            }
        } catch (Exception e) {
            // Fallback if detailed CPU info not available
        }
        
        performanceData.add("cpu", cpu);
        
        // Thread information
        JsonObject threads = new JsonObject();
        ThreadMXBean threadBean = ManagementFactory.getThreadMXBean();
        
        threads.addProperty("thread_count", threadBean.getThreadCount());
        threads.addProperty("daemon_thread_count", threadBean.getDaemonThreadCount());
        threads.addProperty("peak_thread_count", threadBean.getPeakThreadCount());
        threads.addProperty("total_started_thread_count", threadBean.getTotalStartedThreadCount());
        
        performanceData.add("threads", threads);
        
        // Server tick information
        JsonObject ticks = new JsonObject();
        
        // Average tick time over last 100 ticks
        long[] tickTimesLong = server.tickTimes;
        if (tickTimesLong != null && tickTimesLong.length > 0) {
            double totalTickTime = 0;
            int validTicks = 0;
            for (long tickTime : tickTimesLong) {
                if (tickTime > 0) {
                    totalTickTime += tickTime;
                    validTicks++;
                }
            }
            if (validTicks > 0) {
                double avgTickTime = totalTickTime / validTicks / 1000000.0; // Convert to milliseconds
                ticks.addProperty("average_tick_time_ms", avgTickTime);
                ticks.addProperty("tps", Math.min(20.0, 1000.0 / avgTickTime));
            }
        }
        
        // Current tick
        ticks.addProperty("current_tick", server.getTickCount());
        
        performanceData.add("ticks", ticks);
        
        // Server uptime
        JsonObject uptime = new JsonObject();
        long uptimeMs = ManagementFactory.getRuntimeMXBean().getUptime();
        uptime.addProperty("uptime_ms", uptimeMs);
        uptime.addProperty("uptime_seconds", uptimeMs / 1000);
        uptime.addProperty("uptime_minutes", uptimeMs / 60000);
        uptime.addProperty("uptime_hours", uptimeMs / 3600000);
        
        performanceData.add("uptime", uptime);
        
        // JVM information
        JsonObject jvm = new JsonObject();
        jvm.addProperty("java_version", System.getProperty("java.version"));
        jvm.addProperty("java_vendor", System.getProperty("java.vendor"));
        jvm.addProperty("jvm_name", System.getProperty("java.vm.name"));
        jvm.addProperty("jvm_version", System.getProperty("java.vm.version"));
        jvm.addProperty("os_name", System.getProperty("os.name"));
        jvm.addProperty("os_arch", System.getProperty("os.arch"));
        jvm.addProperty("os_version", System.getProperty("os.version"));
        
        performanceData.add("jvm", jvm);
        
        return performanceData;
    }
}