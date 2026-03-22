import Cocoa

@main
class DojoMenuBarApp: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var statusMenuItem: NSMenuItem!
    var healthTimer: Timer?
    var isRunning = false

    static func main() {
        let app = NSApplication.shared
        let delegate = DojoMenuBarApp()
        app.delegate = delegate
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Hide dock icon — menu bar only
        NSApp.setActivationPolicy(.accessory)

        // Create status bar item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        if let button = statusItem.button {
            // Try to load the PDF icon from the app bundle or ~/.dojo/
            if let icon = loadIcon() {
                icon.isTemplate = true // Adapts to light/dark mode
                icon.size = NSSize(width: 18, height: 18)
                button.image = icon
            } else {
                button.title = "🥋"
            }
            button.toolTip = "Agent D.O.J.O."
        }

        // Build menu
        let menu = NSMenu()

        statusMenuItem = NSMenuItem(title: "Checking status...", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)

        menu.addItem(NSMenuItem.separator())

        let enterItem = NSMenuItem(title: "Enter the Dojo", action: #selector(openDashboard), keyEquivalent: "d")
        enterItem.target = self
        menu.addItem(enterItem)

        menu.addItem(NSMenuItem.separator())

        let startItem = NSMenuItem(title: "Start Server", action: #selector(startServer), keyEquivalent: "")
        startItem.target = self
        menu.addItem(startItem)

        let stopItem = NSMenuItem(title: "Stop Server", action: #selector(stopServer), keyEquivalent: "")
        stopItem.target = self
        menu.addItem(stopItem)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "Quit Menu Bar", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu

        // Check health immediately and then every 10 seconds
        checkHealth()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.checkHealth()
        }
    }

    func loadIcon() -> NSImage? {
        // Try bundle first
        if let bundlePath = Bundle.main.path(forResource: "dojologo", ofType: "pdf") {
            return NSImage(contentsOfFile: bundlePath)
        }
        // Try ~/.dojo/ location
        let homeDir = FileManager.default.homeDirectoryForCurrentUser
        let dojoIconPath = homeDir.appendingPathComponent(".dojo/dojologo.pdf").path
        if FileManager.default.fileExists(atPath: dojoIconPath) {
            return NSImage(contentsOfFile: dojoIconPath)
        }
        return nil
    }

    func checkHealth() {
        guard let url = URL(string: "http://localhost:3001/api/health") else { return }

        let task = URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }

                if let data = data,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let ok = json["ok"] as? Bool, ok,
                   let info = json["data"] as? [String: Any] {

                    self.isRunning = true
                    let agents = info["agents"] as? Int ?? 0
                    let uptime = info["uptime"] as? Int ?? 0
                    let uptimeStr = self.formatUptime(uptime)

                    self.statusMenuItem.title = "🟢 Running — \(agents) agents, uptime \(uptimeStr)"

                    if let button = self.statusItem.button {
                        button.appearsDisabled = false
                    }
                } else {
                    self.isRunning = false
                    self.statusMenuItem.title = "🔴 Server not running"

                    if let button = self.statusItem.button {
                        button.appearsDisabled = true
                    }
                }
            }
        }
        task.resume()
    }

    func formatUptime(_ seconds: Int) -> String {
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86400 { return "\(seconds / 3600)h \((seconds % 3600) / 60)m" }
        return "\(seconds / 86400)d \((seconds % 86400) / 3600)h"
    }

    @objc func openDashboard() {
        if let url = URL(string: "http://localhost:3001") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func startServer() {
        let scriptPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".dojo/scripts/start.sh").path

        if FileManager.default.fileExists(atPath: scriptPath) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = [scriptPath]
            try? process.run()

            statusMenuItem.title = "🟡 Starting..."
            // Recheck after a few seconds
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                self?.checkHealth()
            }
        }
    }

    @objc func stopServer() {
        let scriptPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".dojo/scripts/stop.sh").path

        if FileManager.default.fileExists(atPath: scriptPath) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = [scriptPath]
            try? process.run()

            statusMenuItem.title = "🔴 Stopping..."
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                self?.checkHealth()
            }
        }
    }

    @objc func quitApp() {
        NSApp.terminate(nil)
    }
}
