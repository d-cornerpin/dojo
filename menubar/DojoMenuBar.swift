import Cocoa

@main
class DojoMenuBarApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem!
    var statusMenuItem: NSMenuItem!
    var rollbackMenuItem: NSMenuItem!
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
            // The DOJO logo (a monochrome silhouette), loaded from the app
            // bundle or ~/.dojo/. It's a template image so it adapts to the
            // light/dark menu bar.
            if let icon = loadIcon() {
                icon.isTemplate = true
                icon.size = NSSize(width: 18, height: 18)
                button.image = icon
            } else if let symbol = NSImage(systemSymbolName: "figure.martial.arts", accessibilityDescription: "DOJO") {
                // Fallback if the logo asset is missing: a monochrome SF Symbol
                // that also adapts to light/dark — never a raw emoji.
                symbol.isTemplate = true
                button.image = symbol
            } else {
                button.title = "🥋"
            }
            button.toolTip = "Agent D.O.J.O."
        }

        // Build menu
        let menu = NSMenu()
        // We manage enablement ourselves (the rollback item disables when there
        // is no backup to restore), so don't let AppKit auto-toggle items.
        menu.autoenablesItems = false
        menu.delegate = self

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

        // Roll back to the previous version, using the backup the updater saved.
        // Works even when the server won't boot (it shells out to a self-contained
        // script, not the API). Title/enabled state is refreshed on menu open.
        rollbackMenuItem = NSMenuItem(title: "Roll Back…", action: #selector(rollBack), keyEquivalent: "")
        rollbackMenuItem.target = self
        menu.addItem(rollbackMenuItem)
        refreshRollbackItem()

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
        // The logo ships as a vector PDF (added to the bundle by build.sh and
        // dropped into ~/.dojo/ by the installer). A PNG is also accepted as a
        // fallback. Bundle copy wins; ~/.dojo/ is the runtime fallback.
        for ext in ["pdf", "png"] {
            if let bundlePath = Bundle.main.path(forResource: "dojologo", ofType: ext),
               let img = NSImage(contentsOfFile: bundlePath) {
                return img
            }
        }
        let homeDir = FileManager.default.homeDirectoryForCurrentUser
        for ext in ["pdf", "png"] {
            let p = homeDir.appendingPathComponent(".dojo/dojologo.\(ext)").path
            if FileManager.default.fileExists(atPath: p), let img = NSImage(contentsOfFile: p) {
                return img
            }
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

    // Refresh the rollback item right before the menu is shown, so the version
    // shown (and whether it's available) is always current.
    func menuWillOpen(_ menu: NSMenu) {
        refreshRollbackItem()
    }

    // The newest ~/.dojo/platform.backup-<version> directory, if any. Newest by
    // modification time == the version we were on before the last update.
    func newestBackup() -> (path: String, version: String)? {
        let dojo = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".dojo")
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: dojo, includingPropertiesForKeys: [.contentModificationDateKey], options: []) else { return nil }

        let prefix = "platform.backup-"
        var newestURL: URL?
        var newestDate = Date.distantPast
        for url in entries where url.lastPathComponent.hasPrefix(prefix) {
            let mdate = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? Date.distantPast
            if mdate > newestDate {
                newestDate = mdate
                newestURL = url
            }
        }
        guard let n = newestURL else { return nil }
        return (n.path, String(n.lastPathComponent.dropFirst(prefix.count)))
    }

    func refreshRollbackItem() {
        guard rollbackMenuItem != nil else { return }
        if let backup = newestBackup() {
            rollbackMenuItem.title = "Roll Back to \(backup.version)…"
            rollbackMenuItem.isEnabled = true
        } else {
            rollbackMenuItem.title = "Roll Back (no backup found)"
            rollbackMenuItem.isEnabled = false
        }
    }

    @objc func rollBack() {
        guard let backup = newestBackup() else { return }

        let confirm = NSAlert()
        confirm.messageText = "Roll back DOJO to \(backup.version)?"
        confirm.informativeText = "The current version will be set aside (kept for diagnosis) and the server restarted on \(backup.version). Use this if an update left the server unable to start."
        confirm.alertStyle = .warning
        confirm.addButton(withTitle: "Roll Back")
        confirm.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard confirm.runModal() == .alertFirstButtonReturn else { return }

        let scriptPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".dojo/scripts/rollback.sh").path
        guard FileManager.default.fileExists(atPath: scriptPath) else {
            showResult(title: "Rollback unavailable",
                       text: "rollback.sh was not found in ~/.dojo/scripts. Reinstall or update DOJO to get it.")
            return
        }

        statusMenuItem.title = "🟡 Rolling back to \(backup.version)..."

        DispatchQueue.global().async { [weak self] in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = [scriptPath]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe

            var output = ""
            do {
                try process.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                output = String(data: data, encoding: .utf8) ?? ""
            } catch {
                output = "Failed to launch rollback.sh: \(error.localizedDescription)"
            }

            let succeeded = process.terminationStatus == 0
            DispatchQueue.main.async {
                self?.showResult(
                    title: succeeded ? "Rolled back to \(backup.version)" : "Rollback failed",
                    text: output.isEmpty ? "(no output)" : output)
                // Give launchd a few seconds to bring the restored build up.
                DispatchQueue.main.asyncAfter(deadline: .now() + 6) { self?.checkHealth() }
            }
        }
    }

    func showResult(title: String, text: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    @objc func quitApp() {
        NSApp.terminate(nil)
    }
}
