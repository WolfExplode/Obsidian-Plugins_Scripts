// Check minimum required Excalidraw Automate version
if(!ea.verifyMinimumPluginVersion || !ea.verifyMinimumPluginVersion("2.14.2")) {
  new ea.obsidian.Notice("This script requires Excalidraw plugin version 2.14.2 or higher. Please update your plugin.");
  return;
}

// -----------------------------------------------------
// 1. Initialization and Data Structures
// -----------------------------------------------------

// Get all elements in the current drawing
const allElements = ea.getViewElements();

// Regex to capture YouTube IDs from standard and short URLs
// Group 1: Video ID
// Group 2: Full query/hash string (to preserve timestamps like ?t=993)
const youtubeRegex = /^(?:https?:\/\/)?(?:www\.)?(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|live\/))([a-zA-Z0-9_-]{11})([^&\s]*)/;

// Array to hold data for each new image to be created, one per link-containing element
const elementsToReplace = [];

// -----------------------------------------------------
// 2. Scan ALL Elements for YouTube Links
// -----------------------------------------------------

for (const el of allElements) {
  // Check element's text (for text elements) AND the element's link property
  let url = el.type === "text" ? el.text.trim() : el.link;

  // Also check if the element's text is the same as its link, often the case when pasting a URL as a link
  if (!url && el.type === "text" && el.link) {
      url = el.link.trim();
  }

  if (!url) continue;

  const match = url.match(youtubeRegex);

  if (match) {
    const videoID = match[1];
    // Reconstruct the full link to preserve the timestamp, e.g., ?t=993
    const fullLink = `https://youtu.be/${videoID}${match[2] || ""}`; 
    // Construct the direct link to the high-resolution thumbnail image
    const thumbnailUrl = `https://img.youtube.com/vi/${videoID}/maxresdefault.jpg`;
    
    // Store the data needed to replace the current element
    elementsToReplace.push({
      elementId: el.id,
      originalX: el.x + el.width / 2,
      originalY: el.y + el.height / 2,
      originalWidth: el.width,
      originalHeight: el.height,
      fullLink,
      thumbnailUrl,
    });
  }
}

if (elementsToReplace.length === 0) {
  new ea.obsidian.Notice("No elements containing a valid YouTube link were found in the drawing.");
  return;
}

// -----------------------------------------------------
// 3. Delete Old Elements and Prepare Workbench
// -----------------------------------------------------

// Get the actual element objects corresponding to the IDs we want to delete/modify
const elementsToDelete = elementsToReplace.map(data => {
    // Find the actual element object from the original array
    return allElements.find(el => el.id === data.elementId);
}).filter(el => el); 

// Copy the actual element objects (not just IDs) to the workbench for deletion/modification
ea.copyViewElementsToEAforEditing(elementsToDelete);

// Mark the original elements for deletion
for (const data of elementsToReplace) {
    const el = ea.getElement(data.elementId);
    if (el) el.isDeleted = true;
}

// -----------------------------------------------------
// 4. Insert New Image Elements AND SET THE LINK EXPLICITLY
// -----------------------------------------------------
const newImageIds = [];
const DEFAULT_WIDTH = 560; 
const ASPECT_RATIO = 16/9;

for (const data of elementsToReplace) {
  // Determine new image size, prioritizing old element's size if reasonable
  // Text elements often have small widths, so use a sensible default.
  const newWidth = data.originalWidth > 100 || data.originalWidth === 0
    ? DEFAULT_WIDTH 
    : data.originalWidth;
  const newHeight = newWidth / ASPECT_RATIO;
  
  // 1. Clear the link from the global style to avoid unintended propagation/overrides
  ea.style.link = null; 
  
  // 2. Add the image element using the thumbnail URL. It will be positioned using the original center.
  const imageId = await ea.addImage(
    data.originalX - newWidth / 2, // Center the image X
    data.originalY - newHeight / 2, // Center the image Y
    data.thumbnailUrl, 
    false, // Do not auto-scale to fit max size
    false  // Do not anchor 
  );

  const newImage = ea.getElement(imageId);
  
  if (newImage) {
    // 3. Manually set size and, CRUCIALLY, the correct link directly on the element
    newImage.width = newWidth;
    newImage.height = newHeight;
    newImage.link = data.fullLink; // <--- Set the original YouTube URL as the element's link
  }
  
  newImageIds.push(imageId);
}

// -----------------------------------------------------
// 5. Commit Changes and Select New Elements
// -----------------------------------------------------

// Commit all deletions and additions to the view
await ea.addElementsToView(false, true, true);

// Select the newly created images for user convenience
ea.selectElementsInView(newImageIds);
