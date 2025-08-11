package com.akumas.mcpanel;

import java.net.HttpURLConnection;
import java.net.URL;
import java.io.BufferedReader;
import java.io.InputStreamReader;

/**
 * Simple client to test the HTTP server functionality
 */
public class TestClient {
    public static void main(String[] args) {
        String[] endpoints = {
            "http://localhost:25580/api/status",
            "http://localhost:25580/api/all",
            "http://localhost:25580/api/performance"
        };
        
        for (String endpoint : endpoints) {
            System.out.println("Testing endpoint: " + endpoint);
            try {
                URL url = new URL(endpoint);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                
                int responseCode = conn.getResponseCode();
                System.out.println("Response Code: " + responseCode);
                
                if (responseCode == 200) {
                    BufferedReader in = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                    String inputLine;
                    StringBuilder content = new StringBuilder();
                    while ((inputLine = in.readLine()) != null) {
                        content.append(inputLine);
                    }
                    in.close();
                    System.out.println("Response: " + content.toString());
                } else {
                    System.out.println("Error response");
                }
                
            } catch (Exception e) {
                System.out.println("Error: " + e.getMessage());
            }
            System.out.println();
        }
    }
}