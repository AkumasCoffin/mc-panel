package com.akumas.mcpanel.events;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.logging.Logger;
import java.util.logging.Level;
import java.util.logging.Handler;
import java.util.logging.LogRecord;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.regex.Pattern;
import java.util.regex.Matcher;

/**
 * Captures console output and log messages from the Minecraft server.
 * Provides real-time log monitoring and error/warning detection capabilities.
 */
public class ConsoleCapture {
    private static final Logger LOGGER = Logger.getLogger(ConsoleCapture.class.getName());
    
    // Log message storage
    private final ConcurrentLinkedQueue<JsonObject> logMessages = new ConcurrentLinkedQueue<>();
    private final ConcurrentLinkedQueue<JsonObject> errorMessages = new ConcurrentLinkedQueue<>();
    private final ConcurrentLinkedQueue<JsonObject> warningMessages = new ConcurrentLinkedQueue<>();
    private final ConcurrentLinkedQueue<JsonObject> commandOutputs = new ConcurrentLinkedQueue<>();
    
    private static final int MAX_LOG_MESSAGES = 1000;
    private static final int MAX_ERROR_MESSAGES = 200;
    private static final int MAX_WARNING_MESSAGES = 300;
    private static final int MAX_COMMAND_OUTPUTS = 100;
    
    // Log handler for capturing console output
    private LogHandler logHandler;
    private volatile boolean captureEnabled = true;
    
    // Patterns for detecting different types of messages
    private static final Pattern ERROR_PATTERN = Pattern.compile("(ERROR|FATAL|Exception|Error)", Pattern.CASE_INSENSITIVE);
    private static final Pattern WARNING_PATTERN = Pattern.compile("(WARN|WARNING)", Pattern.CASE_INSENSITIVE);
    private static final Pattern COMMAND_PATTERN = Pattern.compile("\\[.*?\\] \\[.*?\\] (.+) issued server command: (.+)");
    private static final Pattern CHAT_PATTERN = Pattern.compile("<(.+?)> (.+)");
    
    public ConsoleCapture() {
        LOGGER.info("ConsoleCapture initialized");
    }
    
    /**
     * Start capturing console output
     */
    public void start() {
        try {
            if (logHandler == null) {
                logHandler = new LogHandler();
                
                // Add handler to root logger to capture all log messages
                Logger rootLogger = Logger.getLogger("");
                rootLogger.addHandler(logHandler);
                
                LOGGER.info("Console capture started");
            }
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Failed to start console capture", e);
        }
    }
    
    /**
     * Stop capturing console output
     */
    public void stop() {
        try {
            if (logHandler != null) {
                Logger rootLogger = Logger.getLogger("");
                rootLogger.removeHandler(logHandler);
                logHandler = null;
                
                LOGGER.info("Console capture stopped");
            }
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "Failed to stop console capture", e);
        }
    }
    
    /**
     * Process a log message and categorize it
     */
    private void processLogMessage(LogRecord record) {
        if (!captureEnabled) {
            return;
        }
        
        try {
            String message = record.getMessage();
            String level = record.getLevel().getName();
            long timestamp = record.getMillis();
            String loggerName = record.getLoggerName();
            
            // Create base log entry
            JsonObject logEntry = new JsonObject();
            logEntry.addProperty("timestamp", timestamp);
            logEntry.addProperty("level", level);
            logEntry.addProperty("message", message);
            logEntry.addProperty("logger", loggerName);
            
            // Add exception info if present
            if (record.getThrown() != null) {
                Throwable thrown = record.getThrown();
                logEntry.addProperty("exception_class", thrown.getClass().getName());
                logEntry.addProperty("exception_message", thrown.getMessage());
                
                // Add stack trace
                JsonArray stackTrace = new JsonArray();
                for (StackTraceElement element : thrown.getStackTrace()) {
                    stackTrace.add(element.toString());
                }
                logEntry.add("stack_trace", stackTrace);
            }
            
            // Categorize the message
            categorizeMessage(logEntry, message, level);
            
            // Add to general log
            addLogMessage(logEntry);
            
        } catch (Exception e) {
            // Avoid infinite recursion if logging the error causes another error
            System.err.println("Error processing log message: " + e.getMessage());
        }
    }
    
    /**
     * Categorize a log message into different types
     */
    private void categorizeMessage(JsonObject logEntry, String message, String level) {
        // Check for errors
        if ("SEVERE".equals(level) || ERROR_PATTERN.matcher(message).find()) {
            logEntry.addProperty("category", "error");
            addErrorMessage(logEntry.deepCopy());
        }
        // Check for warnings
        else if ("WARNING".equals(level) || WARNING_PATTERN.matcher(message).find()) {
            logEntry.addProperty("category", "warning");
            addWarningMessage(logEntry.deepCopy());
        }
        // Check for command execution
        else if (COMMAND_PATTERN.matcher(message).find()) {
            logEntry.addProperty("category", "command");
            parseCommandOutput(logEntry.deepCopy(), message);
        }
        // Check for chat messages
        else if (CHAT_PATTERN.matcher(message).find()) {
            logEntry.addProperty("category", "chat");
        }
        // Default category
        else {
            logEntry.addProperty("category", "info");
        }
    }
    
    /**
     * Parse command output from log messages
     */
    private void parseCommandOutput(JsonObject logEntry, String message) {
        try {
            Matcher matcher = COMMAND_PATTERN.matcher(message);
            if (matcher.find()) {
                String player = matcher.group(1);
                String command = matcher.group(2);
                
                logEntry.addProperty("command_player", player);
                logEntry.addProperty("command_executed", command);
                
                addCommandOutput(logEntry);
            }
        } catch (Exception e) {
            LOGGER.log(Level.FINE, "Error parsing command output", e);
        }
    }
    
    /**
     * Add a log message to the storage
     */
    private void addLogMessage(JsonObject logMessage) {
        logMessages.offer(logMessage);
        
        // Keep only the most recent messages
        while (logMessages.size() > MAX_LOG_MESSAGES) {
            logMessages.poll();
        }
    }
    
    /**
     * Add an error message to the storage
     */
    private void addErrorMessage(JsonObject errorMessage) {
        errorMessages.offer(errorMessage);
        
        // Keep only the most recent messages
        while (errorMessages.size() > MAX_ERROR_MESSAGES) {
            errorMessages.poll();
        }
    }
    
    /**
     * Add a warning message to the storage
     */
    private void addWarningMessage(JsonObject warningMessage) {
        warningMessages.offer(warningMessage);
        
        // Keep only the most recent messages
        while (warningMessages.size() > MAX_WARNING_MESSAGES) {
            warningMessages.poll();
        }
    }
    
    /**
     * Add a command output to the storage
     */
    private void addCommandOutput(JsonObject commandOutput) {
        commandOutputs.offer(commandOutput);
        
        // Keep only the most recent messages
        while (commandOutputs.size() > MAX_COMMAND_OUTPUTS) {
            commandOutputs.poll();
        }
    }
    
    /**
     * Get recent log messages
     */
    public JsonArray getLogMessages(int limit) {
        JsonArray logs = new JsonArray();
        int count = 0;
        
        Object[] messages = logMessages.toArray();
        for (int i = messages.length - 1; i >= 0 && count < limit; i--) {
            logs.add((JsonObject) messages[i]);
            count++;
        }
        
        return logs;
    }
    
    /**
     * Get recent error messages
     */
    public JsonArray getErrorMessages(int limit) {
        JsonArray errors = new JsonArray();
        int count = 0;
        
        Object[] messages = errorMessages.toArray();
        for (int i = messages.length - 1; i >= 0 && count < limit; i--) {
            errors.add((JsonObject) messages[i]);
            count++;
        }
        
        return errors;
    }
    
    /**
     * Get recent warning messages
     */
    public JsonArray getWarningMessages(int limit) {
        JsonArray warnings = new JsonArray();
        int count = 0;
        
        Object[] messages = warningMessages.toArray();
        for (int i = messages.length - 1; i >= 0 && count < limit; i--) {
            warnings.add((JsonObject) messages[i]);
            count++;
        }
        
        return warnings;
    }
    
    /**
     * Get recent command outputs
     */
    public JsonArray getCommandOutputs(int limit) {
        JsonArray commands = new JsonArray();
        int count = 0;
        
        Object[] messages = commandOutputs.toArray();
        for (int i = messages.length - 1; i >= 0 && count < limit; i--) {
            commands.add((JsonObject) messages[i]);
            count++;
        }
        
        return commands;
    }
    
    /**
     * Get comprehensive console data for API responses
     */
    public JsonObject getConsoleData() {
        JsonObject data = new JsonObject();
        data.addProperty("timestamp", System.currentTimeMillis());
        data.addProperty("capture_enabled", captureEnabled);
        data.addProperty("total_logs", logMessages.size());
        data.addProperty("total_errors", errorMessages.size());
        data.addProperty("total_warnings", warningMessages.size());
        data.addProperty("total_commands", commandOutputs.size());
        
        // Add recent messages
        data.add("recent_logs", getLogMessages(50));
        data.add("recent_errors", getErrorMessages(25));
        data.add("recent_warnings", getWarningMessages(25));
        data.add("recent_commands", getCommandOutputs(20));
        
        return data;
    }
    
    /**
     * Enable or disable log capture
     */
    public void setCaptureEnabled(boolean enabled) {
        this.captureEnabled = enabled;
        LOGGER.info("Console capture " + (enabled ? "enabled" : "disabled"));
    }
    
    /**
     * Clear all stored log messages
     */
    public void clearLogs() {
        logMessages.clear();
        errorMessages.clear();
        warningMessages.clear();
        commandOutputs.clear();
        LOGGER.info("Console logs cleared");
    }
    
    /**
     * Custom log handler for capturing console output
     */
    private class LogHandler extends Handler {
        @Override
        public void publish(LogRecord record) {
            processLogMessage(record);
        }
        
        @Override
        public void flush() {
            // No buffering, so nothing to flush
        }
        
        @Override
        public void close() throws SecurityException {
            // No resources to close
        }
    }
}