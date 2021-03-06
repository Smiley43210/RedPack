const _ = require('./script/lib.js');
const fs = require('fs');
const path = require('path');
const del = require('del');
const slash = require('slash');
const request = require('request');
const progress = require('request-progress');
const os = require('os');
const childProcess = require('child_process');
const {ipcRenderer, shell, autoUpdater} = require('electron');

const DOWNLOAD_SLOTS = 3;
let isBusy = false;

const Directory = {};
Directory.SELF = __dirname;
Directory.PACKS = path.join(Directory.SELF, 'packs');

async function updateProfile(installDirectory, packDirectory, packData) {
	let totalMem = os.totalmem() / 2 ** 30;
	let configuredMem = packData.ram.minimum;
	
	if (totalMem > packData.ram.maximum + 2) {
		configuredMem = packData.ram.maximum;
	} else if (totalMem > packData.ram.preferred + 1) {
		configuredMem = packData.ram.preferred;
	}
	
	let data = JSON.parse(await fs.promises.readFile(path.join(installDirectory, 'launcher_profiles.json'), {encoding: 'utf8'}));
	data.profiles[packData.id] = {
		gameDir: packDirectory,
		icon: packData.profile.icon,
		javaArgs: `-Xmx${configuredMem}G -XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M -Dfml.readTimeout=120 -Dfml.loginTimeout=120`,
		lastUsed: new Date(Date.now() + 1000 * 60 * 5).toISOString(),
		lastVersionId: packData.installation.forge,
		name: packData.name,
		type: 'custom'
	};
	await fs.promises.writeFile(path.join(installDirectory, 'launcher_profiles.json'), JSON.stringify(data, null, 2));
}

function downloadFile(url, destinationDirectory, infoCallback, progressCallback) {
	let infoCalled = false;
	
	return new Promise(async (resolve) => {
		let retries = 3;
		while (retries > 0) {
			try {
				progressCallback({percent: null});
				let promise = new Promise((attemptResolve, reject) => {
					let fileRequest = progress(request(url), {throttle: 50}).on('progress', (state) => {
						if (progressCallback) {
							progressCallback(state);
						}
					}).on('error', (error) => {
						console.log('Network error', url);
						reject();
					}).on('response', (response) => {
						if (response.statusCode !== 200) {
							console.log('Non 200 status code', url);
							reject();

							return;
						}

						let fileName = path.parse(fileRequest.uri.href).base;
						let downloadPath = path.join(destinationDirectory, fileName);
						
						if (!infoCalled && infoCallback) {
							infoCallback(fileRequest, fileName);
						}

						console.log(`Receiving ${url}`);
						fileRequest.pipe(fs.createWriteStream(downloadPath)).on('finish', () => {
							attemptResolve(fileName);
						}).on('error', (error) => {
							console.log('Pipe error', url);
							reject();
						});
					});
				});
				let fileName = await promise;
				resolve(fileName);
				break;
			} catch (error) {
				retries--;
				// Do nothing
			}
		}
		
		if (retries == 0) {
			showSnackbar('Failed to download file! See console for details', 10000);
		}
	});
}

function filterMods(target, packData) {
	let filteredMods = new Map();
	let manualMods = [];
	
	for (let [id, mod] of packData.mods) {
		if (mod.target === target || mod.target === 'both') {
			if (mod.manual) {
				manualMods.push(mod);
			} else {
				filteredMods.set(id, mod);
			}
		}
	}
	
	return {automatic: filteredMods, manual: manualMods};
}

function downloadMods(target, mods, modsDirectory, downloadDirectory, progressElement) {
	let modKeys = Array.from(mods.keys());
	let nextIndex = 0;
	let downloadProgress = 0;
	let progressElements = [];
	let fileMap = new Map();
	
	progressElement.message = `Downloading mods... (0 of ${mods.size} complete)`;
	
	return new Promise((resolve) => {
		function downloadMod(mod, modProgressElement) {
			return new Promise((modResolve) => {
				let aborted = false;
				
				modProgressElement.message = `Verifying ${mod.name}... (0%)`;
				modProgressElement.value = null;
				downloadFile(mod.url, downloadDirectory, (fileRequest, fileName) => {
					fileMap.set(mod.id, fileName);
					// Don't download if the mod is already installed locally
					if (fs.existsSync(path.join(modsDirectory, fileName))) {
						aborted = true;
						fileRequest.abort();
					}
				}, (state) => {
					modProgressElement.message = `${state.percent === null ? 'Verifying' : 'Downloading'} ${mod.name}... (${(state.percent * 100).toFixed()}%)`;
					modProgressElement.value = state.percent;
				}).then(async (fileName) => {
					if (!aborted) {
						let downloadPath = path.join(downloadDirectory, fileName);
						let destinationPath = path.join(modsDirectory, fileName);
						await fs.promises.rename(downloadPath, destinationPath);
					}
					progressElement.value = ++downloadProgress / mods.size;
					progressElement.message = `Downloading mods... (${downloadProgress} of ${mods.size} complete)`;
					
					if (downloadProgress == mods.size) {
						resolve(fileMap);
					}
					
					modResolve();
				});
			});
		}
		
		for (let i = 0; i < DOWNLOAD_SLOTS; i++) {
			let modProgressElement = progressElement.addProgress();
			progressElements.push(modProgressElement);
			
			(async () => {
				while (nextIndex < mods.size) {
					let mod = null;
					
					if (nextIndex < mods.size) {
						mod = mods.get(modKeys[nextIndex++]);
					}
					
					if (mod === null) {
						return;
					} else {
						console.log(`Slot ${i}: Downloading ${mod.name}`);
						await downloadMod(mod, modProgressElement);
					}
				}
				
				modProgressElement.remove();
			})();
		}
	});
}

function getJSON(url) {
	return new Promise((resolve, reject) => {
		request(url, {json: true}, (error, response, data) => {
			if (error) {
				reject(error);
			}

			resolve(data);
		});
	});
}

function showSnackbar(message, timeout = 5000, button = {}) {
	let snackbarElement = _.createHTML(`<div class='mdc-snackbar mdc-snackbar--leading'><div class='mdc-snackbar__surface'><div class='mdc-snackbar__label' role='status' aria-live='polite'>${message}</div><div class='mdc-snackbar__actions'></div></div></div>`, document.body);
	
	if (button.actionText) {
		_.createHTML(`<button type='button' class='mdc-button mdc-snackbar__action'><div class='mdc-button__ripple'></div><span class='mdc-button__label'>${button.actionText}</span></button>`, snackbarElement.querySelector('.mdc-snackbar__actions'));
	}
	if (button.dismiss) {
		_.createHTML(`<button class='mdc-icon-button mdc-snackbar__dismiss material-icons' title='Dismiss'>close</button>`, snackbarElement.querySelector('.mdc-snackbar__actions'));
	}
	
	let snackbar = new mdc.snackbar.MDCSnackbar(snackbarElement);
	snackbar.timeoutMs = timeout;
	snackbar.listen('MDCSnackbar:closing', (event) => {
		if (event.detail.reason == 'action') {
			button.action();
		}
	});
	snackbar.listen('MDCSnackbar:closed', (event) => {
		snackbarElement.parentElement.removeChild(snackbarElement);
	});
	
	snackbar.open();
	
	return snackbar;
}

window.addEventListener('DOMContentLoaded', async () => {
	let baseDirectory = process.env.APPDATA || (process.platform == 'darwin' ? path.join(process.env.HOME, 'Library', 'Application Support') : path.join(process.env.HOME, '.local', 'share'));
	let installDirectory = path.join(baseDirectory, `${(process.platform == 'win32' ? '.' : '')}minecraft`);
	let runtimeDirectory;
	
	if (process.platform == 'win32') {
		runtimeDirectory = path.join(path.parse(process.env.APPDATA).root, 'Program Files (x86)', 'Minecraft Launcher', 'runtime', 'jre-x64', 'bin');
	} else {
		runtimeDirectory = path.join(installDirectory, 'runtime', 'jre-x64', 'jre.bundle', 'Contents', 'Home', 'bin');
	}
	if (!fs.existsSync(runtimeDirectory)) {
		runtimeDirectory = null;
	}
	
	let clientInstallCheck = document.getElementById('client-install-check');
	let serverInstallCheck = document.getElementById('server-install-check');
	let packSelectElement = document.getElementById('pack-select');
	let packNameElement = document.getElementById('pack-name');
	let packAboutElement = document.getElementById('pack-about');
	let packDescriptionElement = document.getElementById('pack-description');
	let packMCVersionElement = document.getElementById('pack-minecraft-version');
	let packForgeVersionElement = document.getElementById('pack-forge-version');
	let packClientInstallElement = document.getElementById('pack-install-client');
	let packServerInstallElement = document.getElementById('pack-install-server');
	let progressGroupElement = document.getElementById('progress');
	let progressElement = document.getElementById('progress-main');
	let toggleAdvancedElement = document.getElementById('advanced-toggle');
	let advancedSettingsElement = document.getElementById('advanced-settings');
	let installDirElement = document.getElementById('install-dir');
	let installDirChangeElement = document.getElementById('install-change');
	let runtimeDirElement = document.getElementById('runtime-dir');
	let runtimeDirChangeElement = document.getElementById('runtime-change');
	let versionElement = document.getElementById('version');
	
	let advancedShown = false;
	let selectedPackElement = null;
	let selectedPack = null;
	let packs;
	
	// Display the version
	versionElement.innerText = `v${ipcRenderer.sendSync('version')}`;
	
	// Resize listener
	const resizeObserver = new ResizeObserver((entries) => {
		for (let entry of entries) {
			let scrollbarOffset = entry.target.offsetWidth - entry.target.clientWidth;
			
			versionElement.style.right = `${scrollbarOffset}px`;
		}
	});
	resizeObserver.observe(document.querySelector('.content'));
	
	// Update listener
	let updateSnackbar = null;
	ipcRenderer.on('update-check', (event, state) => {
		if (state == null) {
			return;
		}
		
		if (updateSnackbar) {
			updateSnackbar.close();
			updateSnackbar = null;
		}
		
		switch (state) {
			case 'checking':
				updateSnackbar = showSnackbar('Checking for application updates...', -1);
				break;
			case 'available':
				updateSnackbar = showSnackbar('An update is available! Downloading...', -1);
				break;
			case 'downloaded':
				updateSnackbar = showSnackbar('An update has been downloaded. Restart to update.', -1, {actionText: 'Restart', action: () => {
					ipcRenderer.send('update-restart');
				}, dismiss: true});
				break;
			case 'error':
				updateSnackbar = showSnackbar('An error occurred downloading the update.', -1, {dismiss: true});
				break;
		}
		
		updateSnackbar.listen('MDCSnackbar:closed', (event) => {
			updateSnackbar = null;
		});
	});
	ipcRenderer.send('update-check');
	
	async function validateInstallDirectory() {
		let value = {};
		
		try {
			let profileData = JSON.parse(await fs.promises.readFile(path.join(installDirectory, 'launcher_profiles.json'), {encoding: 'utf8'}));
			value.valid = true;

			if (selectedPack !== null) {
				let packData = packs.get(selectedPack);
				if (profileData.profiles.forge && profileData.profiles.forge.lastVersionId == packData.installation.forge) {
					value.forgeInstalled = true;
				} else {
					value.forgeInstalled = false;
				}
			}
		} catch (error) {
			value.valid = false;
		}
		
		return value;
	}
	
	function getJavaExecutable() {
		return path.join(runtimeDirectory, process.platform == 'win32' ? 'java.exe' : 'java');
	}
	
	async function checkPrerequisites() {
		let data = await validateInstallDirectory();
		
		while (clientInstallCheck.lastChild) {
			clientInstallCheck.removeChild(clientInstallCheck.lastChild);
		}
		while (serverInstallCheck.lastChild) {
			serverInstallCheck.removeChild(serverInstallCheck.lastChild);
		}
		
		// Client checks
		if (data.valid) {
			_.createHTML(`<div class='row'><span class='material-icons icon'>check_circle</span>Minecraft is installed.</div>`, clientInstallCheck);
		} else {
			_.createHTML(`<div class='row'><span class='material-icons icon'>cancel</span>Minecraft is not installed. Run the Minecraft launcher first!</div>`, clientInstallCheck);
		}
		if (selectedPack !== null) {
			if (data.forgeInstalled) {
				_.createHTML(`<div class='row'><span class='material-icons icon'>check_circle</span>Forge is installed.</div>`, clientInstallCheck);
			} else {
				_.createHTML(`<div class='row'><span class='material-icons icon'>cancel</span>Forge is not installed. Will be installed automatically.</div>`, clientInstallCheck);
			}
		}
		
		// Other checks
		let runtimeValid = false;
		if (runtimeDirectory) {
			if (fs.existsSync(getJavaExecutable())) {
				runtimeValid = true;
			}
		}
		if (runtimeValid) {
			_.createHTML(`<div class='row'><span class='material-icons icon'>check_circle</span>Found Java executable.</div>`, clientInstallCheck);
			_.createHTML(`<div class='row'><span class='material-icons icon'>check_circle</span>Found Java executable.</div>`, serverInstallCheck);
			
			if (selectedPack) {
				packClientInstallElement.removeAttribute('disabled');
				packServerInstallElement.removeAttribute('disabled');
			}
		} else {
			_.createHTML(`<div class='row'><span class='material-icons icon'>cancel</span>Could not find Java executable. Make sure Minecraft is installed and set the runtime location in the advanced settings.</div>`, clientInstallCheck);
			_.createHTML(`<div class='row'><span class='material-icons icon'>cancel</span>Could not find Java executable. Make sure Minecraft is installed and set the runtime location in the advanced settings.</div>`, serverInstallCheck);
			
			packClientInstallElement.setAttribute('disabled', '');
			packServerInstallElement.setAttribute('disabled', '');
		}
		
//		// Server checks
//		_.createHTML(`<div class='row'><span class='material-icons icon'>check_circle</span>No prerequisites.</div>`, serverInstallCheck);
	}
	
	async function showPackInfo(packData) {
		packAboutElement.style.display = '';
		packNameElement.innerText = packData.name;
		packDescriptionElement.innerText = packData.description;
		packMCVersionElement.innerText = packData.version.minecraft;
		packForgeVersionElement.innerText = packData.version.forge;
		
		// Show appropriate text on client button
		try {
			let data = JSON.parse(await fs.promises.readFile(path.join(installDirectory, 'launcher_profiles.json'), {encoding: 'utf8'}));
			if (data.profiles[packData.id]) {
				packClientInstallElement.querySelector('.mdc-button__label').innerText = 'Update Client';
			} else {
				throw new Error();
			}
		} catch (error) {
			packClientInstallElement.querySelector('.mdc-button__label').innerText = 'Install Client';
		}
	}
	
	function toggleAdvancedSettings(shouldShow) {
		advancedShown = shouldShow !== undefined ? shouldShow : !advancedShown;
		
		if (advancedShown) {
			toggleAdvancedElement.querySelector('.mdc-button__label').innerText = 'Hide Advanced Settings';
			toggleAdvancedElement.querySelector('.mdc-button__icon').innerText = 'keyboard_arrow_up';
			advancedSettingsElement.style.display = '';
		} else {
			toggleAdvancedElement.querySelector('.mdc-button__label').innerText = 'Show Advanced Settings';
			toggleAdvancedElement.querySelector('.mdc-button__icon').innerText = 'keyboard_arrow_down';
			advancedSettingsElement.style.display = 'none';
		}
	}
	
	async function installForge(packData, downloadDirectory, type) {
		progressElement.message = 'Downloading Minecraft Forge...';
		await downloadFile(`https://files.minecraftforge.net/maven/net/minecraftforge/forge/${packData.version.forge}/forge-${packData.version.forge}-installer.jar`, downloadDirectory, null, (state) => {
			progressElement.message = `Downloading Minecraft Forge... (${(state.percent * 100).toFixed()}%)`;
			progressElement.value = state.percent;
		}).then(async (fileName) => {
			let filePath = path.join(downloadDirectory, fileName);

			progressElement.value = null;
			progressElement.message = `<div>Installing Minecraft Forge...</div><div>An installer will appear. Choose "Install ${type}" and follow the prompts.</div>`;
			let retries = 3;
			while (retries > 0) {
				try {
					await new Promise((resolve, reject) => {
						childProcess.exec(`"${getJavaExecutable()}" -jar "${filePath}"`, (error) => {
							if (error) {
								reject(error);
							} else {
								resolve();
							}
						});
					});
					break;
				} catch (error) {
					retries--;
					console.error('Error installing Minecraft Forge');
					console.error(error);
				}
			}
			if (retries == 0) {
				showSnackbar('Failed to install Forge! See console for details', 10000);
			}
		});
	}
	
	while (true) {
		try {
			packs = await getJSON('https://raw.githubusercontent.com/Smiley43210/RedPack/master/packs/index.json');
			break;
		} catch (error) {
			// Do nothing
		}
	}
	
	// Convert packs to Map and populate pack list
	{
		let newPacks = new Map();
		let packPromises = [];
		isBusy = true;
		for (let pack of packs) {
			let packItem = _.createHTML(`<div class='item'><div class='title'>${pack}</div><div class='version'>Loading...</div></div>`, packSelectElement);
			
			packPromises.push(getJSON(`https://raw.githubusercontent.com/Smiley43210/RedPack/master/packs/${pack}.json`).then((packData) => {
				packData.id = pack;
				
				packItem.children[0].innerText = packData.name;
				packItem.children[1].innerText = `Minecraft ${packData.version.minecraft}`;
				
				// Convert mods object to a Map
				let newMods = new Map();
				for (let mod in packData.mods) {
					if (packData.mods.hasOwnProperty(mod)) {
						let modObject = packData.mods[mod];
						modObject.id = mod;
						newMods.set(mod, modObject);
					}
				}
				packData.mods = newMods;
				
				newPacks.set(pack, packData);
				
				packItem.addEventListener('click', async () => {
					if (isBusy) {
						return;
					}
					
					if (selectedPackElement) {
						selectedPackElement.classList.remove('selected');
					}
					
					packItem.classList.add('selected');
					selectedPackElement = packItem;
					selectedPack = pack;
					
					await showPackInfo(packData);
					
					packClientInstallElement.removeAttribute('disabled');
					packServerInstallElement.removeAttribute('disabled');
					
					checkPrerequisites();
				});
			}));
		}
		await Promise.all(packPromises);
		isBusy = false;
		packs = newPacks;
	}
	
	packNameElement.innerText = 'Select a Modpack';
	
	// Show install directory
	installDirElement.innerText = installDirectory;
	runtimeDirElement.innerHTML = runtimeDirectory ? runtimeDirectory : '<span style=\'font-style: italic;\'>Directory could not be found</span>';
	await checkPrerequisites();
	
	packClientInstallElement.addEventListener('click', async () => {
		if (selectedPack === null) {
			return;
		}
		
		isBusy = true;
		toggleAdvancedSettings(false);
		packClientInstallElement.setAttribute('disabled', '');
		packServerInstallElement.setAttribute('disabled', '');
		packClientInstallElement.innerText = 'Installing Client...';
		
		let packData = packs.get(selectedPack);
		let packDirectory = path.join(installDirectory, 'modpack', packData.id);
		let modsDirectory = path.join(packDirectory, 'mods');
		let downloadDirectory = path.join(modsDirectory, 'downloading');
		
		// Create subdirectory
		fs.promises.mkdir(downloadDirectory, {recursive: true});
		
		progressGroupElement.style.display = '';
		
		// Validate install directory
		let validityData = await validateInstallDirectory();
		
		if (!validityData.forgeInstalled) {
			// Download and install forge
			await installForge(packData, downloadDirectory, 'client');
		}
		
		progressElement.message = 'Modifying profile...';
		
		// Modify profile
		updateProfile(installDirectory, packDirectory, packData);
		
		// Try to import options
		try {
			fs.copyFileSync(path.join(installDirectory, 'options.txt'), path.join(packDirectory, 'options.txt'), fs.constants.COPYFILE_EXCL);
		} catch (error) {
			// Do nothing
		}
		
		// Separate manual mods
		let filteredMods = filterMods('client', packData);
		
		// Download mods
		let downloadMap = await downloadMods('client', filteredMods.automatic, modsDirectory, downloadDirectory, progressElement);
		
		// Cleanup mods
		// FIXME: Will not work for manual mods like 'mekanism' and 'mekanism-generators'
		let files = fs.readdirSync(modsDirectory);
		let mappedFiles = Array.from(downloadMap.values());
		let installedManualMods = [];
		for (let file of files) {
			if (mappedFiles.indexOf(file) == -1) {
				let found = false;
				
				for (let mod of filteredMods.manual) {
					if (file.toLocaleLowerCase().indexOf(mod.id.toLocaleLowerCase()) > -1) {
						found = true;
						installedManualMods.push(mod.id);
						break;
					}
				}
				
				if (!found) {
					console.log(`File ${file} not part of modpack`);
					await del(slash(path.join(modsDirectory, file)), {force: true});
				}
			}
		}
		
		// Show manual mods
		if (filteredMods.manual.length > installedManualMods.length) {
			progressElement.message = 'Waiting for manually initiated downloads...';
			progressElement.value = null;
			let message = _.createHTML(`<div>${filteredMods.manual.length - installedManualMods.length} mod${filteredMods.manual.length - installedManualMods.length > 1 ? 's' : ''} could not be automatically downloaded. Click each button below to open the mod website and click the proper download link.</div>`, progressGroupElement);
			
			for (let mod of filteredMods.manual) {
				if (installedManualMods.indexOf(mod.id) == -1) {
					let modLink = _.createHTML(`<div style='margin-bottom: 10px;'><span style='margin-right: 1em; font-weight: 500;'>${mod.name}</span><button class='mdc-button mdc-button--raised' style='margin: 10px 0; height: 32px; font-size: 0.75rem;'><span class='mdc-button__label'>Download</span></button></div>`, progressGroupElement);
					let downloadButton = modLink.querySelector('.mdc-button');
					downloadButton.addEventListener('click', (event) => {
						event.preventDefault();
						ipcRenderer.send('manual-mod', mod.name, mod.url, modsDirectory);
						downloadButton.setAttribute('disabled', '');
						ipcRenderer.on('manual-mod', (event, modName, state) => {
							if (modName == mod.name) {
								let label;
								
								if (state == 'waiting') {
									label = 'Waiting for Download...';
								} else if (state == 'downloading') {
									label = 'Downloading...';
								} else {
									label = 'Download Complete';
								}
								
								downloadButton.querySelector('.mdc-button__label').innerText = label;
							}
						});
					});
				}
			}
		} else {
			progressElement.message = 'Modpack installation complete!';
		}
		
		// Delete temporary download directory
		await del(slash(path.join(downloadDirectory, '**')), {force: true});
		
		packClientInstallElement.removeAttribute('disabled');
		packServerInstallElement.removeAttribute('disabled');
		packClientInstallElement.innerText = 'Install Client';
		isBusy = false;
	});
	
	packServerInstallElement.addEventListener('click', async () => {
		if (selectedPack === null) {
			return;
		}
		
		isBusy = true;
		toggleAdvancedSettings(false);
		packClientInstallElement.setAttribute('disabled', '');
		packServerInstallElement.setAttribute('disabled', '');
		packServerInstallElement.innerText = 'Installing Server...';
		
		let packData = packs.get(selectedPack);
		let modsDirectory = path.join(installDirectory, 'mods');
		let downloadDirectory = path.join(modsDirectory, 'downloading');
		
		// Create subdirectory
		fs.promises.mkdir(downloadDirectory, {recursive: true});
		
		progressGroupElement.style.display = '';
		
		// Separate manual mods
		let filteredMods = filterMods('server', packData);
		
		// Download and install forge
		await installForge(packData, installDirectory, 'server');
		
		// Download mods
		let downloadMap = await downloadMods('server', filteredMods.automatic, modsDirectory, downloadDirectory, progressElement);
		progressElement.message = 'Modpack installation complete!';
		
		// Cleanup mods
		// FIXME: Will not work for manual mods like 'mekanism' and 'mekanism-generators'
		let files = fs.readdirSync(modsDirectory);
		let mappedFiles = Array.from(downloadMap.values());
		let installedManualMods = [];
		for (let file of files) {
			if (mappedFiles.indexOf(file) == -1) {
				let found = false;
				
				for (let mod of filteredMods.manual) {
					if (file.toLocaleLowerCase().indexOf(mod.id.toLocaleLowerCase()) > -1) {
						found = true;
						installedManualMods.push(mod.id);
						break;
					}
				}
				
				if (!found) {
					console.log(`File ${file} not part of modpack`);
					await del(slash(path.join(modsDirectory, file)), {force: true});
				}
			}
		}
		
		// Show manual mods
		if (filteredMods.manual.length > installedManualMods.length) {
			progressElement.message = 'Waiting for manually initiated downloads...';
			progressElement.value = null;
			let message = _.createHTML(`<div>${filteredMods.manual.length - installedManualMods.length} mod${filteredMods.manual.length - installedManualMods.length > 1 ? 's' : ''} could not be automatically downloaded. Click each button below to open the mod website and click the proper download link.</div>`, progressGroupElement);
			
			for (let mod of filteredMods.manual) {
				if (installedManualMods.indexOf(mod.id) == -1) {
					let modLink = _.createHTML(`<div style='margin-bottom: 10px;'><span style='margin-right: 1em; font-weight: 500;'>${mod.name}</span><button class='mdc-button mdc-button--raised' style='margin: 10px 0; height: 32px; font-size: 0.75rem;'><span class='mdc-button__label'>Download</span></button></div>`, progressGroupElement);
					let downloadButton = modLink.querySelector('.mdc-button');
					downloadButton.addEventListener('click', (event) => {
						event.preventDefault();
						ipcRenderer.send('manual-mod', mod.name, mod.url, modsDirectory);
						downloadButton.setAttribute('disabled', '');
						ipcRenderer.on('manual-mod', (event, modName, state) => {
							if (modName == mod.name) {
								let label;
								
								if (state == 'waiting') {
									label = 'Waiting for Download...';
								} else if (state == 'downloading') {
									label = 'Downloading...';
								} else {
									label = 'Download Complete';
								}
								
								downloadButton.querySelector('.mdc-button__label').innerText = label;
							}
						});
					});
				}
			}
		} else {
			progressElement.message = 'Modpack installation complete!';
		}
		
		// Delete temporary download directory
		await del(slash(path.join(downloadDirectory, '**')), {force: true});
		
		packClientInstallElement.removeAttribute('disabled');
		packServerInstallElement.removeAttribute('disabled');
		packServerInstallElement.innerText = 'Install Server';
		isBusy = false;
	});
	
	toggleAdvancedElement.addEventListener('click', () => {
		toggleAdvancedSettings();
	});
	
	installDirChangeElement.addEventListener('click', async () => {
		let paths = ipcRenderer.sendSync('folder-select', installDirectory, 'Locate your Minecraft installation directory...');
		
		if (paths) {
			installDirectory = paths[0];
			installDirElement.innerText = paths[0];
			await checkPrerequisites();
		}
	});
	
	runtimeDirChangeElement.addEventListener('click', async () => {
		let paths = ipcRenderer.sendSync('folder-select', runtimeDirectory ? runtimeDirectory : path.parse(process.env.APPDATA).root, 'Locate your Java runtime executable directory...');
		
		if (paths) {
			runtimeDirectory = paths[0];
			
			if (fs.existsSync(path.join(runtimeDirectory, 'jre.bundle'))) {
				runtimeDirectory = path.join(runtimeDirectory, 'jre.bundle', 'Contents', 'Home', 'bin');
			}
			
			runtimeDirElement.innerText = runtimeDirectory;
			await checkPrerequisites();
		}
	});
	
	versionElement.addEventListener('click', () => {
		ipcRenderer.send('open-devtools');
	});
	
//	// Open all links in external browser
//	document.addEventListener('click', (event) => {
//		if (event.target.tagName === 'A' && event.target.href.startsWith('http')) {
//			event.preventDefault();
//			shell.openExternal(event.target.href);
//		}
//	});
});

const _setImmediate = setImmediate;
process.once('loaded', () => {
	global.setImmediate = _setImmediate;
});
