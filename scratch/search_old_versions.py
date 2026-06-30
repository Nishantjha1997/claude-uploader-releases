import os

root_dir = r"c:\Users\ADMIN\Desktop\CLaudeCodeUsageAutoUploader\claude-usage-uploader"
search_terms = ["2.0.0", "v2.0.0"]

for root, dirs, files in os.walk(root_dir):
    if "node_modules" in dirs:
        dirs.remove("node_modules")
    if "dist" in dirs:
        dirs.remove("dist")
    if "bin" in dirs:
        dirs.remove("bin")
        
    for file in files:
        if file.endswith((".js", ".gs", ".html", ".bat", ".iss", ".json", ".txt")):
            file_path = os.path.join(root, file)
            try:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                    for term in search_terms:
                        if term in content:
                            print(f"Found '{term}' in {file_path}")
            except Exception as e:
                print(f"Error reading {file_path}: {e}")
