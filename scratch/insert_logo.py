import os

# Paths
base64_path = r'C:\Users\ADMIN\.gemini\antigravity\brain\0e764fdd-6349-47a2-9250-130ec6087395\scratch\base64_out.txt'
index_path = os.path.join('claude-usage-dashboard', 'Index.html')
style_path = os.path.join('claude-usage-dashboard', 'Stylesheet.html')

print('Reading base64 logo...')
with open(base64_path, 'r', encoding='utf-8') as f:
    base64_data = f.read().strip()
print('Base64 logo length:', len(base64_data))

# 1. Update Index.html
print('Updating Index.html...')
with open(index_path, 'r', encoding='utf-8') as f:
    index_content = f.read()

start_str = '<div class="brand-section">'
end_str = '<ul class="nav-menu">'

start_index = index_content.find(start_str)
end_index = index_content.find(end_str)

if start_index != -1 and end_index != -1 and start_index < end_index:
    original_brand_block = index_content[start_index:end_index]
    print('Found original brand block of length:', len(original_brand_block))
    
    new_brand_section = f"""<div class="brand-section">
        <div class="logo-container">
          <img class="brand-logo" src="data:image/png;base64,{base64_data}" alt="Sigma Solve Logo">
          <div class="brand-subtitle">Claude ROI Tracker</div>
        </div>
      </div>
      \n      """
    
    index_content = index_content[:start_index] + new_brand_section + index_content[end_index:]
    with open(index_path, 'w', encoding='utf-8') as f:
        f.write(index_content)
    print('Index.html updated successfully.')
else:
    print('Error: Could not find exact boundaries in Index.html!')

# 2. Update Stylesheet.html
print('Updating Stylesheet.html...')
with open(style_path, 'r', encoding='utf-8') as f:
    style_content = f.read()

brand_section_style_start = style_content.find('.brand-section {')
if brand_section_style_start != -1:
    print('Found .brand-section styling in Stylesheet.html')
    
    nav_menu_style_start = style_content.find('.nav-menu {')
    if nav_menu_style_start != -1 and brand_section_style_start < nav_menu_style_start:
        original_style_block = style_content[brand_section_style_start:nav_menu_style_start]
        print('Found original style block to replace:', len(original_style_block))
        
        new_style_block = """.brand-section {
  display: flex;
  align-items: center;
  margin-bottom: 2.5rem;
  padding-left: 0.5rem;
}

.logo-container {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.35rem;
  width: 100%;
}

.brand-logo {
  max-height: 38px;
  max-width: 100%;
  object-fit: contain;
  filter: drop-shadow(0 2px 8px rgba(255, 255, 255, 0.05));
}

.brand-subtitle {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--accent-primary);
  font-weight: 700;
  margin-top: 2px;
}

"""
        style_content = style_content[:brand_section_style_start] + new_style_block + style_content[nav_menu_style_start:]
        with open(style_path, 'w', encoding='utf-8') as f:
            f.write(style_content)
        print('Stylesheet.html updated successfully.')
    else:
        print('Could not locate nav-menu styling to demarcate the style block.')
else:
    print('Could not find .brand-section styling in Stylesheet.html')
