import { DefaultAzureCredential } from '@azure/identity';
import {
    AnonymousCredential,
    BlobServiceClient,
    newPipeline,
    PublicAccessType,
    StorageSharedKeyCredential,
} from '@azure/storage-blob';
import internal from 'stream';

type Config = DefaultConfig | ManagedIdentityConfig;

type DefaultConfig = {
    authType: 'default';
    accountKey: string;
    sasToken: string;
    account: string;
    serviceBaseURL?: string;
    containers: ContainerConfig[];
    defaultPath: string;
    cdnBaseURL?: string;
    defaultCacheControl?: string;
    removeCN?: string;
};

type ManagedIdentityConfig = {
    authType: 'msi';
    clientId?: string;
    account: string;
    serviceBaseURL?: string;
    containers: ContainerConfig[];
    defaultPath: string;
    cdnBaseURL?: string;
    defaultCacheControl?: string;
    removeCN?: string;
};

type ContainerConfig = {
    containerName: string;
    createContainerIfNotExist?: string;
    publicAccessType?: PublicAccessType;
}

type StrapiFile = File & {
    stream: internal.Readable;
    hash: string;
    url: string;
    ext: string;
    mime: string;
    path: string;
};

function trimParam(input?: string) {
    return typeof input === 'string' ? input.trim() : '';
}

function getServiceBaseUrl(config: Config) {
    return (
        trimParam(config.serviceBaseURL) ||
        `https://${trimParam(config.account)}.blob.core.windows.net`
    );
}

function getFileName(path: string, file: StrapiFile) {
    return `${trimParam(path)}/${file.hash}${file.ext}`;
}

function makeBlobServiceClient(config: Config) {
    const serviceBaseURL = getServiceBaseUrl(config);

    switch (config.authType) {
        case 'default': {
            const account = trimParam(config.account);
            const accountKey = trimParam(config.accountKey);
            const sasToken = trimParam(config.sasToken);
            if (sasToken != '') {
                const anonymousCredential = new AnonymousCredential();
                return new BlobServiceClient(`${serviceBaseURL}${sasToken}`, anonymousCredential);
            }
            const sharedKeyCredential = new StorageSharedKeyCredential(account, accountKey);
            const pipeline = newPipeline(sharedKeyCredential);
            return new BlobServiceClient(serviceBaseURL, pipeline);
        }
        case 'msi': {
            const clientId = trimParam(config.clientId);
            if (clientId != null && clientId != '') {
                return new BlobServiceClient(
                    serviceBaseURL,
                    new DefaultAzureCredential({ managedIdentityClientId: clientId })
                );
            }
            return new BlobServiceClient(serviceBaseURL, new DefaultAzureCredential());
        }
        default: {
            const exhaustiveCheck: never = config;
            throw new Error(exhaustiveCheck);
        }
    }
}

const uploadOptions = {
    bufferSize: 4 * 1024 * 1024, // 4MB
    maxBuffers: 20,
};

async function handleUpload(
    config: Config,
    blobSvcClient: BlobServiceClient,
    file: StrapiFile,
    containerName: string
): Promise<void> {
    const serviceBaseURL = getServiceBaseUrl(config);
    const containerClient = blobSvcClient.getContainerClient(trimParam(containerName));
    const client = containerClient.getBlockBlobClient(getFileName(config.defaultPath, file));

    const containerConfig = config.containers.find(c => c.containerName === containerName);

    if (trimParam(containerConfig?.createContainerIfNotExist) === 'true') {
        if (
            trimParam(containerConfig?.publicAccessType) === 'container' ||
            trimParam(containerConfig?.publicAccessType) === 'blob'
        ) {
            await containerClient.createIfNotExists({ access: containerConfig.publicAccessType });
        } else {
            await containerClient.createIfNotExists();
        }
    }

    const options = {
        blobHTTPHeaders: {
            blobContentType: file.mime,
            blobCacheControl: trimParam(config.defaultCacheControl),
        },
    };

    const cdnBaseURL = trimParam(config.cdnBaseURL);
    file.url = cdnBaseURL ? client.url.replace(serviceBaseURL, cdnBaseURL) : client.url;
    if (
        file.url.includes(`/${containerName}/`) &&
        config.removeCN &&
        config.removeCN == 'true'
    ) {
        file.url = file.url.replace(`/${containerName}/`, '/');
    }

    await client.uploadStream(
        file.stream,
        uploadOptions.bufferSize,
        uploadOptions.maxBuffers,
        options
    );
}

async function handleDelete(
    config: Config,
    blobSvcClient: BlobServiceClient,
    file: StrapiFile,
    containerName: string
): Promise<void> {
    const containerClient = blobSvcClient.getContainerClient(trimParam(containerName));
    const client = containerClient.getBlobClient(getFileName(config.defaultPath, file));
    await client.delete();
    file.url = client.url;
}

module.exports = {
    provider: 'azure',
    auth: {
        authType: {
            label: 'Authentication type (required, either "msi" or "default")',
            type: 'text',
        },
        clientId: {
            label: 'Azure Identity ClientId (consumed if authType is "msi" and passed as DefaultAzureCredential({ managedIdentityClientId: clientId }))',
            type: 'text',
        },
        account: {
            label: 'Account name (required)',
            type: 'text',
        },
        accountKey: {
            label: 'Secret access key (required if authType is "default")',
            type: 'text',
        },
        serviceBaseURL: {
            label: 'Base service URL to be used, optional. Defaults to https://${account}.blob.core.windows.net (optional)',
            type: 'text',
        },
        containers: {
            label: 'Array of containers (required)',
            type: 'json',
        },
        cdnBaseURL: {
            label: 'CDN base url (optional)',
            type: 'text',
        },
        defaultCacheControl: {
            label: 'Default cache-control setting for all uploaded files',
            type: 'text',
        },
        removeCN: {
            label: 'Remove container name from URL (optional)',
            type: 'text',
        },
    },
    init: (config: Config) => {
        const blobSvcClient = makeBlobServiceClient(config);
        return {
            upload(file: StrapiFile, containerName: string) {
                return handleUpload(config, blobSvcClient, file, containerName);
            },
            uploadStream(file: StrapiFile, containerName: string) {
                return handleUpload(config, blobSvcClient, file, containerName);
            },
            delete(file: StrapiFile, containerName: string) {
                return handleDelete(config, blobSvcClient, file, containerName);
            },
        };
    },
};
