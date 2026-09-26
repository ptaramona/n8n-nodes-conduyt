import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class ConduytApi implements ICredentialType {
	name = 'conduytApi';

	displayName = 'Conduyt API';

	icon: Icon = { light: 'file:conduyt.svg', dark: 'file:conduyt.dark.svg' };

	documentationUrl = 'https://conduyt.app/api-reference';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Generate a key in Conduyt under Settings > API & Webhooks. Keys start with cdy_.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://conduyt.app/api/v1',
			description: 'Only change this if you run Conduyt on a custom domain',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/users/me',
			method: 'GET',
		},
	};
}
