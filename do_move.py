import os
import shutil

root = r"C:\Users\ADMIN\Desktop\CLaudeCodeUsageAutoUploader"
dest_dir = os.path.join(root, "claude-usage-uploader")
os.makedirs(dest_dir, exist_ok=True)

def copy_tree_skip_locked(src, dst):
    """Copy directory tree, skipping files that are locked."""
    os.makedirs(dst, exist_ok=True)
    for entry in os.scandir(src):
        s = entry.path
        d = os.path.join(dst, entry.name)
        if entry.is_dir(follow_symlinks=False):
            copy_tree_skip_locked(s, d)
        else:
            try:
                shutil.copy2(s, d)
            except PermissionError:
                print(f"  LOCKED (skipped): {s}")

# Handle DeveloperSetup specially (has locked exe, and may be partially copied)
ds_src = os.path.join(root, "DeveloperSetup")
ds_dst = os.path.join(dest_dir, "DeveloperSetup")

if os.path.exists(ds_src):
    print("Copying DeveloperSetup (skipping locked files)...")
    copy_tree_skip_locked(ds_src, ds_dst)
    # Clean up nested DeveloperSetup that previous partial run may have created
    nested = os.path.join(ds_dst, "DeveloperSetup")
    if os.path.exists(nested):
        print("  Removing nested DeveloperSetup from previous partial run...")
        shutil.rmtree(nested, ignore_errors=True)
    print("  Done.")

# Move individual top-level files
files = [
    "claude-usage-uploader.js",
    "ClaudeUsageUploader-linux-x64",
    "ClaudeUsageUploader-mac",
    "ClaudeUsageUploader-mac-arm64",
    "ClaudeUsageUploader-mac-x64",
    "ClaudeUsageUploader.exe",
    "Code.gs",
    "Index.html",
    "JavaScript.html",
    "Stylesheet.html",
    "version.json",
    "package.json",
    "package-lock.json",
    "Picture1.svg",
    "SigmaSolve-horizontal-reverse-tagline-logo- (White).jpg",
    "bin",
    "install.sh",
    "installer.iss",
    "launcher.bat",
    "launcher.vbs",
    "webhook-doPost.gs",
]

for item in files:
    s = os.path.join(root, item)
    d = os.path.join(dest_dir, item)
    if not os.path.exists(s):
        continue  # already moved
    if os.path.exists(d):
        continue  # already at destination
    try:
        shutil.move(s, d)
        print(f"Moved: {item}")
    except Exception as e:
        print(f"  FAILED {item}: {e}")

print("\nRoot contents now:")
for f in sorted(os.listdir(root)):
    print(f"  {f}")

print("\nclaude-usage-uploader/ contents:")
for f in sorted(os.listdir(dest_dir)):
    print(f"  {f}")
