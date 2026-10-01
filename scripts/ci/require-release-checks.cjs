const requiredResults = ['APPLICATION_RESULT', 'BROWSER_RESULT', 'WINDOWS_INSTALLER_RESULT', 'SPOOLER_RESULT'];

function requireReleaseChecks(env) {
    const incomplete = requiredResults.filter(key => env[key] !== 'success');
    if (incomplete.length) {
        throw new Error(`Release checks did not pass: ${incomplete.map(key => `${key}=${env[key] || 'missing'}`).join(', ')}`);
    }
}

if (require.main === module) {
    try {
        requireReleaseChecks(process.env);
        console.log('All required release jobs completed successfully, including browser workflows.');
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
module.exports = { requireReleaseChecks, requiredResults };
