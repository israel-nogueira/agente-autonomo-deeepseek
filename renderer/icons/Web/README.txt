Replace My App/App with your application name. Publish the images and site.webmanifest, then add these declarations to your page head:
<link rel="manifest" href="site.webmanifest">
<link rel="icon" href="favicon.ico">
<link rel="apple-touch-icon" href="apple-touch-icon.png">

start_url and scope use ./ relative to the manifest location. The icon paths begin with / and resolve from the origin root; update them if publishing images in a subdirectory. Serve over HTTPS or localhost and inspect the actual manifest/icon responses. These are regular icons, not tested maskable artwork. This package does not add a service worker, offline behavior or guarantee an installation experience. Test your target browser and device.
